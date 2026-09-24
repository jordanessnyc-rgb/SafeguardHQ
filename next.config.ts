import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Document uploads go through server actions. Vercel caps function request bodies at 4.5 MB;
    // larger files (photo sets) will upload browser → Supabase Storage directly in the field view.
    serverActions: { bodySizeLimit: "4mb" },
  },
  serverExternalPackages: ["pg", "pg-boss"],
};

export default nextConfig;
