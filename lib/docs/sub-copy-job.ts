/** Makes the SUB_COPY document for a job's report (SPEC §10). Nothing is saved unless validation passes. */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import type { Uploader } from "@/lib/mail/ingest";
import type { Downloader } from "@/lib/supabase/service";
import { DOCX_TYPE } from "./proposal";
import { makeSubCopy } from "./sub-copy";

export type SubCopyOutcome = { status: "created"; documentId: string; removed: string[] } | { status: "blocked"; violations: string[]; removed: string[] };

export async function createSubCopy(db: Db, reportDocId: string, storage: Uploader & Downloader): Promise<SubCopyOutcome> {
  const [doc] = await db.select().from(s.documents).where(eq(s.documents.id, reportDocId));
  if (!doc?.jobId || doc.kind !== "REPORT") throw new Error("Pick a report document.");
  if (!doc.storageBucket || !doc.storagePath || !/\.docx$/i.test(doc.storagePath)) throw new Error("Sub copies can only be made from a Word (.docx) report file.");

  const { buffer, removed, violations } = makeSubCopy(await storage.download(doc.storageBucket, doc.storagePath));
  if (violations.length) return { status: "blocked", violations, removed };

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.documents).where(and(eq(s.documents.jobId, doc.jobId), eq(s.documents.kind, "SUB_COPY")));
  const title = `Sub copy — ${(doc.title ?? "report").replace(/\.docx$/i, "")}.docx`;
  const path = `jobs/${doc.jobId}/${randomUUID()}-${title.replace(/[^\w.\- ]+/g, "_")}`;
  await storage.upload("job-files", path, buffer, DOCX_TYPE);
  const [created] = await db
    .insert(s.documents)
    .values({ jobId: doc.jobId, kind: "SUB_COPY", status: "DRAFT", version: n + 1, title, containsPricing: false, storageBucket: "job-files", storagePath: path })
    .returning({ id: s.documents.id });
  return { status: "created", documentId: created.id, removed };
}
