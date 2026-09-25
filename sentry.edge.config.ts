import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/observability";

Sentry.init(sentryOptions(process.env.SENTRY_DSN));
