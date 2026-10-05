import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema as s } from "@/lib/db";
import { setupTestDb, createUser, hasTestDb, type TestDb, type TestUser } from "@/tests/helpers/db";
import { loadCallDetails } from "@/lib/comms/quo-call-details";
import { QuoApiError } from "@/lib/integrations/quo";

let t: TestDb; let owner: TestUser; let va: TestUser;
const mock = () => ({ getCallRecordings: vi.fn(async () => [{ id: "CR1", status: "completed", url: "https://media.example.test/call.mp3" }]), getCallVoicemail: vi.fn(async () => { throw new QuoApiError(404); }), getCallSummary: vi.fn(async () => ({ status: "completed", summary: ["Discussed inspection"], nextSteps: ["Confirm access"] })), getCallTranscript: vi.fn(async () => ({ status: "completed", dialogue: [{ content: "Tuesday works", identifier: "+12125550123" }] })) });
const viewer = (u: TestUser, role: string) => ({ id: u.id, role, db: u.as });

describe.skipIf(!hasTestDb)("on-demand Quo call details", () => {
  beforeAll(async () => { t = await setupTestDb(); owner = await createUser(t, "OWNER"); va = await createUser(t, "VA"); });
  afterAll(async () => { await t?.close(); });
  const call = async (fields = {}) => (await t.db.insert(s.activities).values({ type: "CALL", externalId: `AC${crypto.randomUUID()}`, channelLine: "ESS_MAIN", ...fields }).returning())[0];
  it("loads available sections, tolerates missing voicemail, and audits the access", async () => {
    await t.db.update(s.settings).set({ quoSummariesEnabled: true });
    const a = await call(); const client = mock();
    const result = await loadCallDetails(viewer(owner, "OWNER"), a.id, client as never);
    expect(result.recordings.data).toHaveLength(1); expect(result.voicemail.message).toContain("Not available");
    expect(result.summary.data?.nextSteps).toEqual(["Confirm access"]); expect(result.transcript.data).toContain("Tuesday works");
    expect((await t.db.select().from(s.auditLog).where(eq(s.auditLog.entityId, a.id))).some(r => r.action === "READ")).toBe(true);
    const [saved] = await t.db.select().from(s.activities).where(eq(s.activities.id, a.id));
    expect(saved.raw).toBeNull(); expect(saved.transcript).toBeNull();
  });
  it("blocks non-owners before contacting Quo", async () => {
    const a = await call(); const client = mock();
    await expect(loadCallDetails(viewer(va, "VA"), a.id, client as never)).rejects.toThrow("Only the owner");
    expect(client.getCallRecordings).not.toHaveBeenCalled();
  });
  it("blocks AIRnyc flags, lines, and job associations before any provider fetch", async () => {
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "AIRNYC", pipelineKey: "INSPECTION", stage: "LEAD" }).returning();
    for (const fields of [{ sensitive: true }, { channelLine: "AIRNYC" }, { jobId: job.id }]) {
      const a = await call(fields); const client = mock();
      await expect(loadCallDetails(viewer(owner, "OWNER"), a.id, client as never)).rejects.toThrow("Protected AIRnyc");
      expect(client.getCallRecordings).not.toHaveBeenCalled();
    }
  });
  it("does not request summaries or transcripts when disabled", async () => {
    await t.db.update(s.settings).set({ quoSummariesEnabled: false });
    const a = await call(); const client = mock(); const result = await loadCallDetails(viewer(owner, "OWNER"), a.id, client as never);
    expect(client.getCallSummary).not.toHaveBeenCalled(); expect(client.getCallTranscript).not.toHaveBeenCalled();
    expect(result.summary.message).toContain("Enable"); expect(client.getCallRecordings).toHaveBeenCalledOnce();
  });
  it("a missing CRM activity cannot be used to query arbitrary Quo calls", async () => {
    const client = mock(); await expect(loadCallDetails(viewer(owner, "OWNER"), crypto.randomUUID(), client as never)).rejects.toThrow("not found");
    expect(client.getCallRecordings).not.toHaveBeenCalled();
  });
});
