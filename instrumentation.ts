import * as Sentry from "@sentry/nextjs";

// Error tracking (SPEC §13). The SDKs stay disabled unless SENTRY_DSN is set.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
