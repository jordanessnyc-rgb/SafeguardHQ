/**
 * FreshBooks (SPEC §6.2). Verified against the official docs + SDKs on 2026-09-24:
 *  - OAuth authorization code: auth.freshbooks.com/oauth/authorize → POST api.freshbooks.com/auth/oauth/token.
 *    Redirect URI must be HTTPS. Refresh tokens are ONE-TIME-USE and only one is alive at a time,
 *    so refreshes are serialized with a Postgres advisory lock and the new pair saved atomically.
 *  - Identity: GET /auth/api/v1/users/me → response.business_memberships[].business.{account_id,id,name}.
 *  - Invoices are created as drafts by default; sending is a separate PUT (action_email).
 *  - Webhooks ("callbacks") are form-encoded {name, object_id, account_id, business_id, …}, have
 *    NO delivery id, no ordering guarantee, and are signed with X-FreshBooks-Hmac-SHA256 =
 *    base64(HMAC-SHA256(verifier, python_json_dumps(form))). We treat each one as "re-fetch
 *    object_id", which makes duplicates and out-of-order deliveries harmless.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto";

// Mock-server overrides for local end-to-end only; ignored in production so tokens can't be sent elsewhere.
const devOverride = (v: string | undefined) => (process.env.NODE_ENV === "production" ? undefined : v || undefined);
export const FB_API = devOverride(process.env.FRESHBOOKS_API_BASE) ?? "https://api.freshbooks.com";
export const FB_AUTH = devOverride(process.env.FRESHBOOKS_AUTH_BASE) ?? "https://auth.freshbooks.com";
export const FB_SCOPES = [
  "user:profile:read",
  "user:clients:read",
  "user:clients:write",
  "user:invoices:read",
  "user:invoices:write",
  "user:payments:read",
];
export const FB_WEBHOOK_EVENTS = ["invoice.create", "invoice.update", "invoice.delete", "payment.create", "payment.update", "payment.delete", "client.create", "client.update"];

export type FbConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function fbConfigFromEnv(env = process.env): FbConfig | null {
  if (!env.FRESHBOOKS_CLIENT_ID || !env.FRESHBOOKS_CLIENT_SECRET || !env.FRESHBOOKS_REDIRECT_URI) return null;
  return { clientId: env.FRESHBOOKS_CLIENT_ID, clientSecret: env.FRESHBOOKS_CLIENT_SECRET, redirectUri: env.FRESHBOOKS_REDIRECT_URI };
}

/**
 * No `scope` parameter: FreshBooks then grants the scopes ticked on the app itself. Sending an explicit
 * list failed in production ("The requested scope is invalid, unknown, or malformed") as soon as the
 * app's ticked scopes didn't match it exactly. FRESHBOOKS_SCOPES can still force a list if ever needed.
 */
export function authorizeUrl(cfg: FbConfig, state: string, scopes = process.env.FRESHBOOKS_SCOPES): string {
  const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, state });
  if (scopes) q.set("scope", scopes);
  return `${FB_AUTH}/oauth/authorize/?${q}`;
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in?: number; scope?: string };

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const res = await fetchImpl(`${FB_API}/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Version": "alpha" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`FreshBooks token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function exchangeCode(cfg: FbConfig, code: string, fetchImpl?: typeof fetch) {
  return tokenRequest({ grant_type: "authorization_code", client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri }, fetchImpl);
}

export type FbIdentity = { accountId: string; businessId: string | null; businessName: string | null };

export async function fetchIdentity(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<FbIdentity> {
  const res = await fetchImpl(`${FB_API}/auth/api/v1/users/me`, { headers: { Authorization: `Bearer ${accessToken}`, "Api-Version": "alpha" } });
  if (!res.ok) throw new Error(`FreshBooks identity ${res.status}`);
  const me = (await res.json()) as { response: { business_memberships?: { business?: { id?: number | string; name?: string; account_id?: string } }[] } };
  const biz = me.response.business_memberships?.find((m) => m.business?.account_id)?.business;
  if (!biz?.account_id) throw new Error("This FreshBooks login has no business with an accounting account.");
  return { accountId: biz.account_id, businessId: biz.id != null ? String(biz.id) : null, businessName: biz.name ?? null };
}

export async function saveConnection(db: Db, tokens: TokenResponse, identity: FbIdentity, connectedBy: string | null) {
  const values = {
    id: 1,
    accountId: identity.accountId,
    businessId: identity.businessId,
    businessName: identity.businessName,
    accessTokenEnc: encryptField(tokens.access_token)!,
    refreshTokenEnc: encryptField(tokens.refresh_token)!,
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    scopes: tokens.scope ?? FB_SCOPES.join(" "),
    connectedBy,
    lastRefreshAt: new Date(),
    lastError: null,
  };
  await db.insert(s.freshbooksConnection).values(values).onConflictDoUpdate({ target: s.freshbooksConnection.id, set: values });
}

// ---------------------------------------------------------------------------------------------
// API client with single-flight, locked token refresh
// ---------------------------------------------------------------------------------------------

export class FreshBooksNotConnected extends Error {
  constructor() {
    super("FreshBooks isn't connected (Settings → FreshBooks).");
  }
}

export class FreshBooksClient {
  constructor(
    private db: Db,
    private cfg: FbConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async accountId(): Promise<string> {
    const [c] = await this.db.select({ accountId: s.freshbooksConnection.accountId }).from(s.freshbooksConnection);
    if (!c) throw new FreshBooksNotConnected();
    return c.accountId;
  }

  /** Returns a valid access token, refreshing (once, under a DB lock) when it's near expiry. */
  async accessToken(force = false): Promise<string> {
    const [c] = await this.db.select().from(s.freshbooksConnection);
    if (!c) throw new FreshBooksNotConnected();
    if (!force && c.expiresAt.getTime() - Date.now() > 120_000) return decryptField(c.accessTokenEnc)!;

    return this.db.transaction(async (tx) => {
      // Only one refresh at a time across web + worker: refresh tokens are single-use.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('freshbooks-token-refresh'))`);
      const [cur] = await tx.select().from(s.freshbooksConnection).for("update");
      if (!cur) throw new FreshBooksNotConnected();
      if (!force && cur.accessTokenEnc !== c.accessTokenEnc && cur.expiresAt.getTime() - Date.now() > 120_000) {
        return decryptField(cur.accessTokenEnc)!; // another process refreshed while we waited for the lock
      }
      try {
        const t = await tokenRequest(
          { grant_type: "refresh_token", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: decryptField(cur.refreshTokenEnc)!, redirect_uri: this.cfg.redirectUri },
          this.fetchImpl,
        );
        await tx
          .update(s.freshbooksConnection)
          .set({
            accessTokenEnc: encryptField(t.access_token)!,
            refreshTokenEnc: encryptField(t.refresh_token)!,
            expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
            lastRefreshAt: new Date(),
            lastError: null,
          })
          .where(eq(s.freshbooksConnection.id, 1));
        return t.access_token;
      } catch (e) {
        await tx.update(s.freshbooksConnection).set({ lastError: (e as Error).message.slice(0, 500) }).where(eq(s.freshbooksConnection.id, 1));
        throw e;
      }
    });
  }

  /** JSON request with retries on 429/5xx (exponential backoff) and one forced refresh on 401. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.accessToken();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${FB_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Api-Version": "alpha" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) {
        token = await this.accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`FreshBooks ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  private async acct(path: string) {
    return `/accounting/account/${await this.accountId()}${path}`;
  }

  // --- clients ---
  async listClients(page = 1): Promise<{ clients: FbClient[]; pages: number }> {
    const r = await this.request<{ response: { result: { clients: FbClient[]; pages: number } } }>("GET", await this.acct(`/users/clients?page=${page}&per_page=100`));
    return r.response.result;
  }
  async findClientByEmail(email: string): Promise<FbClient | null> {
    const r = await this.request<{ response: { result: { clients: FbClient[] } } }>("GET", await this.acct(`/users/clients?search%5Bemail%5D=${encodeURIComponent(email)}`));
    return r.response.result.clients.find((c) => c.vis_state === 0) ?? null;
  }
  async getClient(id: string): Promise<FbClient> {
    const r = await this.request<{ response: { result: { client: FbClient } } }>("GET", await this.acct(`/users/clients/${id}`));
    return r.response.result.client;
  }
  async createClient(c: Partial<FbClient>): Promise<FbClient> {
    const r = await this.request<{ response: { result: { client: FbClient } } }>("POST", await this.acct(`/users/clients`), { client: c });
    return r.response.result.client;
  }

  // --- invoices ---
  async createInvoice(invoice: Record<string, unknown>): Promise<FbInvoice> {
    const r = await this.request<{ response: { result: { invoice: FbInvoice } } }>("POST", await this.acct(`/invoices/invoices`), { invoice });
    return r.response.result.invoice;
  }
  async getInvoice(id: string): Promise<FbInvoice> {
    const r = await this.request<{ response: { result: { invoice: FbInvoice } } }>("GET", await this.acct(`/invoices/invoices/${id}`));
    return r.response.result.invoice;
  }
  async listInvoicesForClient(customerId: string): Promise<FbInvoice[]> {
    const r = await this.request<{ response: { result: { invoices: FbInvoice[] } } }>(
      "GET",
      await this.acct(`/invoices/invoices?search%5Bcustomerid%5D=${encodeURIComponent(customerId)}&per_page=100`),
    );
    return r.response.result.invoices;
  }
  async emailInvoice(id: string, recipients: string[]): Promise<void> {
    await this.request("PUT", await this.acct(`/invoices/invoices/${id}`), { invoice: { action_email: true, email_recipients: recipients } });
  }

  // --- payments ---
  async getPayment(id: string): Promise<FbPayment> {
    const r = await this.request<{ response: { result: { payment: FbPayment } } }>("GET", await this.acct(`/payments/payments/${id}`));
    return r.response.result.payment;
  }

  // --- webhooks ---
  async listCallbacks(): Promise<{ callbackid: number | string; event: string; uri: string; verified: boolean }[]> {
    const r = await this.request<{ response: { result: { callbacks: { callbackid: number; event: string; uri: string; verified: boolean }[] } } }>(
      "GET",
      `/events/account/${await this.accountId()}/events/callbacks`,
    );
    return r.response.result.callbacks;
  }
  async createCallback(event: string, uri: string): Promise<{ callbackid: number | string }> {
    const r = await this.request<{ response: { result: { callback: { callbackid: number } } } }>("POST", `/events/account/${await this.accountId()}/events/callbacks`, { callback: { event, uri } });
    return r.response.result.callback;
  }
  async verifyCallback(callbackId: string, verifier: string): Promise<void> {
    await this.request("PUT", `/events/account/${await this.accountId()}/events/callbacks/${callbackId}`, { callback: { verifier } });
  }
}

export type FbClient = { id: number; userid?: number; fname?: string | null; lname?: string | null; organization?: string | null; email?: string | null; mob_phone?: string | null; bus_phone?: string | null; vis_state?: number };
export type Money = { amount: string; code: string };
export type FbInvoice = {
  id: number;
  invoiceid?: number;
  invoice_number?: string;
  customerid?: number;
  create_date?: string;
  due_date?: string;
  updated?: string;
  v3_status?: string;
  payment_status?: string;
  display_status?: string;
  vis_state?: number;
  amount?: Money;
  outstanding?: Money;
  paid?: Money;
  notes?: string;
  currency_code?: string;
};
export type FbPayment = { id: number; logid?: number; invoiceid?: number; amount?: Money; date?: string; type?: string; vis_state?: number; updated?: string };

export function freshbooksFromEnv(db: Db): FreshBooksClient | null {
  const cfg = fbConfigFromEnv();
  return cfg ? new FreshBooksClient(db, cfg) : null;
}

// ---------------------------------------------------------------------------------------------
// Webhook signature — Python json.dumps(form) semantics
// ---------------------------------------------------------------------------------------------

/** Mirrors Python's json.dumps(dict) (", " / ": " separators, ensure_ascii) for string values. */
export function pythonJsonDumps(pairs: [string, string][]): string {
  const enc = (v: string) =>
    JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `{${pairs.map(([k, v]) => `${enc(k)}: ${enc(v)}`).join(", ")}}`;
}

export function signFreshbooks(verifier: string, pairs: [string, string][]): string {
  return createHmac("sha256", verifier).update(pythonJsonDumps(pairs), "utf8").digest("base64");
}

/**
 * True if `signature` matches any known verifier. FreshBooks doesn't document key order, so we
 * accept the form's received order and, as a fallback, sorted keys.
 */
export function verifyFreshbooksSignature(signature: string | null, pairs: [string, string][], verifiers: string[]): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  const orders = [pairs, [...pairs].sort(([a], [b]) => a.localeCompare(b))];
  return verifiers.some((v) =>
    orders.some((p) => {
      const expected = Buffer.from(signFreshbooks(v, p));
      return expected.length === given.length && timingSafeEqual(expected, given);
    }),
  );
}
