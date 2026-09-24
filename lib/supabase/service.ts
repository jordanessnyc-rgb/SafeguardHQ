/**
 * Service-role Supabase client for the worker (no "server-only" import, which throws outside
 * Next.js). Never import this from client components.
 */
import { createClient } from "@supabase/supabase-js";
import type { Uploader } from "@/lib/mail/ingest";

export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are not set");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function storageUploader(): Uploader {
  const sb = supabaseService();
  return {
    async upload(bucket, path, data, contentType) {
      const { error } = await sb.storage.from(bucket).upload(path, data, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`);
    },
  };
}

export type Downloader = { download(bucket: string, path: string): Promise<Buffer> };

export function storageDownloader(): Downloader {
  const sb = supabaseService();
  return {
    async download(bucket, path) {
      const { data, error } = await sb.storage.from(bucket).download(path);
      if (error || !data) throw new Error(`Storage download failed (${bucket}/${path}): ${error?.message ?? "no data"}`);
      return Buffer.from(await data.arrayBuffer());
    },
  };
}
