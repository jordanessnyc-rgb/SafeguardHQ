/**
 * Error reporting (SPEC §13 "error tracking (Sentry)"). Off unless SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN
 * is set. Pricing and AIRnyc data must not leave through error reports, so:
 * - no session replay, no request bodies, cookies or headers, no default PII;
 * - emails, phone numbers and dollar amounts in messages are masked before sending;
 * - query strings are dropped from URLs (they can carry search terms and names).
 * Verified against @sentry/nextjs 11 docs (instrumentation.ts + onRequestError, instrumentation-client.ts,
 * global-error.tsx) and @sentry/node 11 for the worker.
 */
type AnyEvent = {
  message?: string;
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: Record<string, string>; query_string?: unknown };
  user?: { id?: string | number } & Record<string, unknown>;
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  extra?: Record<string, unknown>;
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g;

export function scrubText(s: string): string {
  return s.replace(EMAIL, "[email]").replace(MONEY, "[amount]").replace(PHONE, "[phone]");
}
const stripQuery = (u?: string) => (u ? u.split("?")[0] : u);

/** beforeSend for every runtime. Mutates and returns the event. */
export function scrubEvent<E>(event: E): E {
  const e = event as AnyEvent;
  if (e.message) e.message = scrubText(e.message);
  for (const v of e.exception?.values ?? []) if (v.value) v.value = scrubText(v.value);
  if (e.request) {
    e.request = { url: stripQuery(e.request.url), headers: e.request.headers?.["user-agent"] ? { "user-agent": e.request.headers["user-agent"] } : undefined };
  }
  if (e.user) e.user = e.user.id != null ? { id: e.user.id } : undefined;
  for (const b of e.breadcrumbs ?? []) {
    if (b.message) b.message = scrubText(b.message);
    if (b.data) b.data = { url: stripQuery(b.data.url as string | undefined), method: b.data.method, status_code: b.data.status_code };
  }
  if (e.extra) e.extra = Object.fromEntries(Object.entries(e.extra).map(([k, v]) => [k, typeof v === "string" ? scrubText(v) : v]));
  return event;
}

/** Options shared by the server, edge, client and worker SDKs. */
export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors only; no performance data
    beforeSend: scrubEvent,
  };
}

let reporter: ((e: unknown, ctx?: Record<string, unknown>) => void) | null = null;
/** The worker registers @sentry/node's captureException here at startup (see worker/sentry.ts). */
export function setErrorReporter(fn: typeof reporter) {
  reporter = fn;
}
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  reporter?.(error, context);
}
