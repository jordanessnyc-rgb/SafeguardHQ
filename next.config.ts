import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  experimental: {
    // Document uploads go through server actions. Vercel caps function request bodies at 4.5 MB;
    // larger files (photo sets) will upload browser → Supabase Storage directly in the field view.
    serverActions: { bodySizeLimit: "4mb" },
  },
  serverExternalPackages: ["pg", "pg-boss"],
};

// Source maps upload to Sentry only when SENTRY_AUTH_TOKEN is set (e.g. on Vercel); otherwise skipped.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
