/** Worker error tracking: @sentry/node, same scrubbing as the web app. Off without SENTRY_DSN. */
import * as Sentry from "@sentry/node";
import { sentryOptions, setErrorReporter } from "@/lib/observability";

export function initWorkerSentry() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({ ...sentryOptions(process.env.SENTRY_DSN), serverName: "worker" });
  setErrorReporter((e, ctx) => Sentry.captureException(e, ctx ? { tags: Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, String(v)])) } : undefined));
}
