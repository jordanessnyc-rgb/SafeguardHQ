/**
 * In-memory FreshBooks API for tests: behaves like the documented API where it matters —
 * single-use refresh tokens, draft-by-default invoices, response envelopes, callbacks + verifier.
 */
type Json = Record<string, unknown>;

export class FakeFreshBooks {
  accountId = "ACC1";
  accessToken = "at-0";
  refreshToken = "rt-0";
  refreshCount = 0;
  clients: Json[] = [];
  invoices: Json[] = [];
  payments: Json[] = [];
  callbacks: { callbackid: number; event: string; uri: string; verified: boolean; verifier: string }[] = [];
  emailed: { id: string; recipients: string[] }[] = [];
  calls: { method: string; path: string; body?: Json }[] = [];
  private seq = 100;

  fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    this.calls.push({ method, path: u.pathname + u.search, body });
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const wrap = (result: unknown) => ok({ response: { result } });

    if (u.pathname === "/auth/oauth/token") {
      if (body?.grant_type === "refresh_token") {
        // Single-use: only the current refresh token works.
        if (body.refresh_token !== this.refreshToken) return ok({ error: "invalid_grant" }, 401);
        this.refreshCount++;
        this.accessToken = `at-${this.refreshCount}`;
        this.refreshToken = `rt-${this.refreshCount}`;
        return ok({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 43200 });
      }
      return ok({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 43200, scope: "user:profile:read" });
    }
    if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${this.accessToken}`) return ok({ error: "unauthorized" }, 401);
    if (u.pathname === "/auth/api/v1/users/me") {
      return ok({ response: { business_memberships: [{ business: { id: 77, name: "Environmental Safeguard Solutions", account_id: this.accountId } }] } });
    }

    const acct = `/accounting/account/${this.accountId}`;
    const events = `/events/account/${this.accountId}/events/callbacks`;
    if (u.pathname === `${acct}/users/clients`) {
      if (method === "POST") {
        const c = { id: ++this.seq, vis_state: 0, ...(body!.client as Json) };
        this.clients.push(c);
        return wrap({ client: c });
      }
      const email = u.searchParams.get("search[email]");
      const list = email ? this.clients.filter((c) => c.email === email) : this.clients;
      return wrap({ clients: list, page: 1, pages: 1, per_page: 100, total: list.length });
    }
    const clientMatch = u.pathname.match(new RegExp(`^${acct}/users/clients/(\\d+)$`));
    if (clientMatch) return wrap({ client: this.clients.find((c) => String(c.id) === clientMatch[1]) });

    if (u.pathname === `${acct}/invoices/invoices`) {
      if (method === "POST") {
        const inv = body!.invoice as Json;
        const lines = inv.lines as { qty: number; unit_cost: { amount: string } }[];
        const total = lines.reduce((n, l) => n + l.qty * Number(l.unit_cost.amount), 0).toFixed(2);
        const id = ++this.seq;
        const created = {
          ...inv,
          id,
          invoiceid: id,
          invoice_number: String(1000 + this.invoices.length + 1),
          v3_status: "draft",
          payment_status: "unpaid",
          vis_state: 0,
          amount: { amount: total, code: "USD" },
          outstanding: { amount: total, code: "USD" },
          paid: { amount: "0.00", code: "USD" },
          due_date: "2026-10-24",
          updated: new Date().toISOString(),
        };
        this.invoices.push(created);
        return wrap({ invoice: created });
      }
      const cust = u.searchParams.get("search[customerid]");
      return wrap({ invoices: this.invoices.filter((i) => !cust || String(i.customerid) === cust), pages: 1 });
    }
    const invMatch = u.pathname.match(new RegExp(`^${acct}/invoices/invoices/(\\d+)$`));
    if (invMatch) {
      const inv = this.invoices.find((i) => String(i.id) === invMatch[1]);
      if (!inv) return ok({ error: "not found" }, 404);
      if (method === "PUT") {
        const upd = body!.invoice as Json;
        if (upd.action_email) {
          this.emailed.push({ id: invMatch[1], recipients: upd.email_recipients as string[] });
          inv.v3_status = "sent";
        }
      }
      return wrap({ invoice: inv });
    }
    const payMatch = u.pathname.match(new RegExp(`^${acct}/payments/payments/(\\d+)$`));
    if (payMatch) return wrap({ payment: this.payments.find((p) => String(p.id) === payMatch[1]) });

    if (u.pathname === events) {
      if (method === "POST") {
        const cb = body!.callback as { event: string; uri: string };
        const created = { callbackid: ++this.seq, event: cb.event, uri: cb.uri, verified: false, verifier: `ver-${this.seq}` };
        this.callbacks.push(created);
        return wrap({ callback: created });
      }
      return wrap({ callbacks: this.callbacks });
    }
    const cbMatch = u.pathname.match(new RegExp(`^${events}/(\\d+)$`));
    if (cbMatch && method === "PUT") {
      const cb = this.callbacks.find((c) => String(c.callbackid) === cbMatch[1])!;
      cb.verified = (body!.callback as Json).verifier === cb.verifier;
      return wrap({ callback: cb });
    }
    return ok({ error: `unhandled ${method} ${u.pathname}` }, 404);
  };

  /** Simulates the client paying in FreshBooks: records a payment and updates the invoice. */
  pay(invoiceId: string, amount: number) {
    const inv = this.invoices.find((i) => String(i.id) === invoiceId)!;
    const id = ++this.seq;
    this.payments.push({ id, logid: id, invoiceid: Number(invoiceId), amount: { amount: amount.toFixed(2), code: "USD" }, date: "2026-09-25", type: "Check", vis_state: 0 });
    const paid = Number((inv.paid as { amount: string }).amount) + amount;
    const total = Number((inv.amount as { amount: string }).amount);
    inv.paid = { amount: paid.toFixed(2), code: "USD" };
    inv.outstanding = { amount: Math.max(0, total - paid).toFixed(2), code: "USD" };
    inv.v3_status = paid >= total ? "paid" : "partial";
    inv.payment_status = paid >= total ? "paid" : "partial";
    inv.updated = new Date(Date.now() + 1000).toISOString();
    return String(id);
  }
}
