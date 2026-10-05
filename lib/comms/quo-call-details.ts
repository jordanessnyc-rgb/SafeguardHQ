import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { schema as s } from "@/lib/db";
import { QuoApiError, type QuoClient } from "@/lib/integrations/quo";

export type CallSection<T> = { data?: T; message?: string };
export type QuoCallDetails = {
  recordings: CallSection<{ url: string; duration?: number | null }[]>;
  voicemail: CallSection<{ url?: string; transcript?: string | null }>;
  summary: CallSection<{ text: string; nextSteps: string[] }>;
  transcript: CallSection<string>;
};

type Viewer = { id: string; role: string | null; db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** Signed media URLs remain in memory only; no recording/transcript writes or client messages. */
export async function loadCallDetails(viewer: Viewer, activityId: string, quo: QuoClient): Promise<QuoCallDetails> {
  if (viewer.role !== "OWNER") throw new Error("Only the owner can load Quo call details.");
  const call = await viewer.db(async (tx) => {
    const [a] = await tx.select().from(s.activities).where(and(eq(s.activities.id, activityId), eq(s.activities.type, "CALL")));
    if (!a?.externalId) throw new Error("Quo call not found.");
    const [job] = a.jobId ? await tx.select({ service: s.jobs.serviceCode, caseId: s.jobs.airnycCaseId }).from(s.jobs).where(eq(s.jobs.id, a.jobId)) : [];
    if (a.sensitive || a.airnycCaseId || a.channelLine === "AIRNYC" || job?.service === "AIRNYC" || job?.caseId) {
      throw new Error("Protected AIRnyc call details must be reviewed in Quo.");
    }
    const [cfg] = await tx.select({ summaries: s.settings.quoSummariesEnabled }).from(s.settings);
    await tx.insert(s.auditLog).values({ actor: viewer.id, action: "READ", entity: "activities", entityId: a.id, detail: { view: "quo-call-details" } });
    return { id: a.externalId, summaries: cfg?.summaries === true };
  });
  // Leave the RLS transaction before contacting the provider. All endpoints are GET requests.
  async function section<T>(fetchData: () => Promise<T>): Promise<CallSection<T>> {
    try { return { data: await fetchData() }; }
    catch (e) {
      if (e instanceof QuoApiError && e.status === 404) return { message: "Not available for this call yet." };
      if (e instanceof QuoApiError && e.status === 403) return { message: "Not available with this Quo account's permissions or plan." };
      if (e instanceof QuoApiError && e.status === 401) return { message: "Quo authentication failed. Check the API key in the server settings." };
      return { message: "Could not load this part of the call. Try again." };
    }
  }
  const [recordings, voicemail, summary, transcript] = await Promise.all([
    section(async () => (await quo.getCallRecordings(call.id)).filter(r => r.status === "completed" && safeMediaUrl(r.url)).map(r => ({ url: safeMediaUrl(r.url)!, duration: r.duration }))),
    section(async () => { const v = await quo.getCallVoicemail(call.id); if (v.status !== "completed") throw new QuoApiError(404); return { url: safeMediaUrl(v.recordingUrl), transcript: v.transcript }; }),
    call.summaries ? section(async () => { const v = await quo.getCallSummary(call.id); if (v.status !== "completed") throw new QuoApiError(404); return { text: (v.summary ?? []).join("\n"), nextSteps: v.nextSteps ?? [] }; }) : Promise.resolve({ message: "Enable Quo summaries and transcripts in Communications settings to load this." }),
    call.summaries ? section(async () => { const v = await quo.getCallTranscript(call.id); if (v.status !== "completed") throw new QuoApiError(404); return (v.dialogue ?? []).map(d => `${d.identifier ?? (d.userId ? "ESS" : "Caller")}: ${d.content}`).join("\n"); }) : Promise.resolve({ message: "Quo summaries and transcripts are disabled in Communications settings." }),
  ]);
  return { recordings, voicemail, summary, transcript };
}

export function safeMediaUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
