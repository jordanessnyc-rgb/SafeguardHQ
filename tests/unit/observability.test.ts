/** Phase 6d: error reports never carry contact details, amounts, request bodies or query strings. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import { captureError, scrubEvent, scrubText, sentryOptions, setErrorReporter } from "@/lib/observability";

describe("scrubbing", () => {
  it("masks emails, phone numbers and dollar amounts", () => {
    expect(scrubText("Email maria.lee@example.com or call (718) 555-0100 about the $1,250.00 quote")).toBe("Email [email] or call [phone] about the [amount] quote");
    expect(scrubText("Job ESS-2026-0142 failed at step 3")).toBe("Job ESS-2026-0142 failed at step 3"); // job numbers survive
  });
  it("drops request bodies, cookies, headers, query strings and user details", () => {
    const e = scrubEvent({
      message: "x",
      request: { url: "https://crm/search?q=Maria+Lee", data: { price: 900 }, cookies: { sb: "t" }, headers: { cookie: "sb=t", "user-agent": "UA" } },
      user: { id: "u1", email: "jordan@ess-nyc.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "fetch", data: { url: "/api/documents/1?download=1", method: "GET", body: "secret" } }],
    });
    expect(e.request).toEqual({ url: "https://crm/search", headers: { "user-agent": "UA" } });
    expect(e.user).toEqual({ id: "u1" });
    expect(e.breadcrumbs[0].data).toEqual({ url: "/api/documents/1", method: "GET", status_code: undefined });
  });
  it("is disabled without a DSN", () => {
    expect(sentryOptions(undefined)).toMatchObject({ enabled: false, sendDefaultPii: false, tracesSampleRate: 0 });
  });
});

describe("real SDK (worker)", () => {
  it("sends a scrubbed event to the DSN", async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (bodies.push(b), res.end("{}")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      Sentry.init({ ...sentryOptions(`http://publickey@127.0.0.1:${port}/1`), defaultIntegrations: false });
      setErrorReporter((e, ctx) => Sentry.captureException(e, { tags: ctx as Record<string, string> }));
      captureError(new Error("FreshBooks rejected invoice for maria.lee@example.com, $1,250.00, 718-555-0100"), { task: "invoices" });
      await Sentry.flush(3000);
      const sent = bodies.join("\n");
      expect(sent).toContain("FreshBooks rejected invoice for [email], [amount], [phone]");
      expect(sent).toContain('"task":"invoices"');
      expect(sent).not.toMatch(/maria\.lee|1,250|555-0100/);
    } finally {
      await Sentry.close(1000);
      setErrorReporter(null);
      server.close();
    }
  });
});
