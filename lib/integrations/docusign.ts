/**
 * DocuSign eSignature REST v2.1 (SPEC §6.7), verified against developers.docusign.com 2026-09-24:
 *  - Auth: JWT Grant (DocuSign's recommendation for one system account; no refresh tokens). One-time
 *    consent at {authHost}/oauth/auth with scope "signature impersonation"; tokens last 1 hour.
 *    Hosts: account-d.docusign.com (demo) / account.docusign.com (production; needs Go-Live review).
 *  - GET {authHost}/oauth/userinfo → accounts[].base_uri; API base = base_uri + /restapi/v2.1/accounts/{id}.
 *  - Envelopes accept .docx (converted to PDF). status "sent" sends; "created" is a draft.
 *  - Envelope-level eventNotification (JSON SIM when eventData.version = "restv2.1"); HMAC via
 *    includeHMAC needs Connect keys created in eSignature Admin (the API can't create them).
 *  - Connect HMAC: X-DocuSign-Signature-N = base64(HMAC-SHA256(raw body, key)); any match is valid.
 *  - No delivery ID in Connect payloads/headers → dedupe on a body hash and re-fetch envelope state.
 *  - Signed file: GET .../envelopes/{id}/documents/combined?certificate=true (PDF bytes).
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export type DocuSignConfig = { integrationKey: string; userId: string; privateKey: string; authHost: string; accountId?: string; hmacKeys: string[] };

export function docusignConfigFromEnv(env = process.env): DocuSignConfig | null {
  if (!env.DOCUSIGN_INTEGRATION_KEY || !env.DOCUSIGN_USER_ID || !env.DOCUSIGN_PRIVATE_KEY) return null;
  return {
    integrationKey: env.DOCUSIGN_INTEGRATION_KEY,
    userId: env.DOCUSIGN_USER_ID,
    privateKey: env.DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, "\n"),
    authHost: env.DOCUSIGN_ENV === "production" ? "account.docusign.com" : "account-d.docusign.com",
    accountId: env.DOCUSIGN_ACCOUNT_ID || undefined,
    hmacKeys: (env.DOCUSIGN_HMAC_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
  };
}

/** One-time admin consent link for the JWT integration (open it logged in as the sending user). */
export function consentUrl(cfg: DocuSignConfig, redirectUri: string): string {
  const q = new URLSearchParams({ response_type: "code", scope: "signature impersonation", client_id: cfg.integrationKey, redirect_uri: redirectUri });
  return `https://${cfg.authHost}/oauth/auth?${q}`;
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export function jwtAssertion(cfg: DocuSignConfig, now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ iss: cfg.integrationKey, sub: cfg.userId, aud: cfg.authHost, iat, exp: iat + 3600, scope: "signature impersonation" }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(cfg.privateKey))}`;
}

export type EnvelopeStatus = { envelopeId: string; status: string; completedDateTime?: string; voidedReason?: string; statusChangedDateTime?: string };

export class DocuSignClient {
  private token?: { value: string; exp: number };
  private base?: string;
  constructor(
    private cfg: DocuSignConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp - Date.now() > 5 * 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://${this.cfg.authHost}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwtAssertion(this.cfg) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "consent_required") throw new Error("DocuSign consent is needed once — open Settings → DocuSign → Grant consent.");
      throw new Error(`DocuSign token ${res.status}: ${body.error ?? "unknown error"}`);
    }
    this.token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** {base_uri}/restapi/v2.1/accounts/{accountId}, from userinfo (cached). */
  async apiBase(): Promise<string> {
    if (this.base) return this.base;
    const res = await this.fetchImpl(`https://${this.cfg.authHost}/oauth/userinfo`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`DocuSign userinfo ${res.status}`);
    const info = (await res.json()) as { accounts?: { account_id: string; base_uri: string; is_default?: boolean }[] };
    const accts = info.accounts ?? [];
    const acct = this.cfg.accountId ? accts.find((a) => a.account_id === this.cfg.accountId) : (accts.find((a) => a.is_default) ?? accts[0]);
    if (!acct) throw new Error(this.cfg.accountId ? `DocuSign account ${this.cfg.accountId} isn't available to this user.` : "This DocuSign user has no account.");
    this.base = `${acct.base_uri.replace(/\/$/, "")}/restapi/v2.1/accounts/${acct.account_id}`;
    return this.base;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${await this.apiBase()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errorCode?: string; message?: string };
      throw new Error(`DocuSign ${res.status}: ${err.errorCode ?? ""} ${err.message ?? ""}`.trim());
    }
    return res;
  }

  /** Sends one document to one signer. Signature/date tabs are placed at the template's anchor text. */
  async sendEnvelope(o: {
    document: Buffer;
    fileName: string;
    emailSubject: string;
    signer: { email: string; name: string };
    anchors: { signHere: string; dateSigned?: string };
    webhookUrl?: string;
  }): Promise<string> {
    const anchor = (s: string) => ({ anchorString: s, anchorUnits: "pixels", anchorXOffset: "0", anchorYOffset: "0" });
    const body = {
      emailSubject: o.emailSubject.slice(0, 100),
      status: "sent",
      documents: [{ documentId: "1", name: o.fileName, fileExtension: o.fileName.split(".").pop(), documentBase64: o.document.toString("base64") }],
      recipients: {
        signers: [
          {
            recipientId: "1",
            routingOrder: "1",
            email: o.signer.email,
            name: o.signer.name,
            tabs: { signHereTabs: [anchor(o.anchors.signHere)], ...(o.anchors.dateSigned ? { dateSignedTabs: [anchor(o.anchors.dateSigned)] } : {}) },
          },
        ],
      },
      ...(o.webhookUrl
        ? {
            eventNotification: {
              url: o.webhookUrl,
              requireAcknowledgment: "true",
              loggingEnabled: "true",
              deliveryMode: "SIM",
              events: ["envelope-completed", "envelope-declined", "envelope-voided"],
              eventData: { version: "restv2.1" },
              includeHMAC: this.cfg.hmacKeys.length ? "true" : "false",
            },
          }
        : {}),
    };
    const res = await this.call("/envelopes", { method: "POST", body: JSON.stringify(body) });
    return ((await res.json()) as { envelopeId: string }).envelopeId;
  }

  async getEnvelope(envelopeId: string): Promise<EnvelopeStatus> {
    return (await (await this.call(`/envelopes/${envelopeId}`)).json()) as EnvelopeStatus;
  }

  /** All documents as one signed PDF, with the certificate of completion appended. */
  async downloadSigned(envelopeId: string): Promise<Buffer> {
    const res = await this.call(`/envelopes/${envelopeId}/documents/combined?certificate=true`, { headers: { Accept: "application/pdf" } });
    return Buffer.from(await res.arrayBuffer());
  }
}

export function docusignFromEnv(): DocuSignClient | null {
  const cfg = docusignConfigFromEnv();
  return cfg ? new DocuSignClient(cfg) : null;
}

/** Connect HMAC: any X-DocuSign-Signature-N header matching any configured key. */
export function verifyDocuSignHmac(rawBody: string | Buffer, headers: Headers, keys: string[]): boolean {
  const sigs: Buffer[] = [];
  for (let i = 1; i <= 100; i++) {
    const v = headers.get(`x-docusign-signature-${i}`);
    if (!v) break;
    sigs.push(Buffer.from(v));
  }
  if (!sigs.length || !keys.length) return false;
  for (const key of keys) {
    const expected = Buffer.from(createHmac("sha256", key).update(rawBody).digest("base64"));
    if (sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected))) return true;
  }
  return false;
}
