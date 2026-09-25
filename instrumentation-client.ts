import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/observability";

// Browser errors. No session replay: screens show pricing and AIRnyc data.
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
