/** DocuSign e-signature (SPEC §6.7): JWT auth, send, Connect HMAC, dedupe, signed copy once. */
import { createHmac, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { DocuSignClient, jwtAssertion, verifyDocuSignHmac, type DocuSignConfig } from "@/lib/integrations/docusign";
import { acceptDocuSignWebhook, processEnvelope, runDocuSignDelivery, sendProposalForSignature, SIGN_ANCHORS } from "@/lib/docs/esign";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cfg: DocuSignConfig = { integrationKey: "ik-1", userId: "user-guid", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), authHost: "account-d.docusign.com", hmacKeys: ["hmac-secret"] };

class FakeDocuSign {
  consented = true;
  envelopes = new Map<string, { status: string; body: Record<string, unknown> }>();
  calls: string[] = [];
  fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    this.calls.push(`${init?.method ?? "GET"} ${u.host}${u.pathname}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/oauth/token") return this.consented ? json({ access_token: "tok", expires_in: 3600 }) : json({ error: "consent_required" }, 400);
    if (u.pathname === "/oauth/userinfo") return json({ accounts: [{ account_id: "acc-9", base_uri: "https://demo.docusign.net", is_default: true }] });
    const base = "/restapi/v2.1/accounts/acc-9/envelopes";
    if (u.pathname === base && init?.method === "POST") {
      const id = `env-${this.envelopes.size + 1}`;
      this.envelopes.set(id, { status: "sent", body: JSON.parse(String(init.body)) });
      return json({ envelopeId: id, status: "sent" }, 201);
    }
    const m = u.pathname.match(/\/envelopes\/([^/]+)(\/documents\/combined)?$/);
    if (m && m[2]) return new Response("%PDF-1.7 signed", { status: 200, headers: { "content-type": "application/pdf" } });
    if (m) return json({ envelopeId: m[1], status: this.envelopes.get(m[1])?.status, completedDateTime: "2026-09-25T14:00:00Z" });
    return json({ errorCode: "NOT_FOUND" }, 404);
  };
}

const sign = (raw: string, key = "hmac-secret") => new Headers({ "x-docusign-signature-1": createHmac("sha256", key).update(raw).digest("base64") });

describe("DocuSign primitives", () => {
  it("JWT assertion is RS256-signed with iss/sub/aud/scope", () => {
    const [h, p, sig] = jwtAssertion(cfg, 1_790_000_000_000).split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iss: "ik-1", sub: "user-guid", aud: "account-d.docusign.com", iat: 1_790_000_000, exp: 1_790_003_600, scope: "signature impersonation" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
  it("Connect HMAC: any matching header/key passes; wrong or missing fails", () => {
    const raw = '{"event":"envelope-completed"}';
    expect(verifyDocuSignHmac(raw, sign(raw), ["other", "hmac-secret"])).toBe(true);
    const two = new Headers({ "x-docusign-signature-1": "nope", "x-docusign-signature-2": createHmac("sha256", "hmac-secret").update(raw).digest("base64") });
    expect(verifyDocuSignHmac(raw, two, ["hmac-secret"])).toBe(true);
    expect(verifyDocuSignHmac(raw + " ", sign(raw), ["hmac-secret"])).toBe(false);
    expect(verifyDocuSignHmac(raw, new Headers(), ["hmac-secret"])).toBe(false);
    expect(verifyDocuSignHmac(raw, sign(raw), [])).toBe(false);
  });
  it("explains missing consent", async () => {
    const fake = new FakeDocuSign();
    fake.consented = false;
    await expect(new DocuSignClient(cfg, fake.fetch as never).apiBase()).rejects.toThrow(/consent is needed once/);
  });
});

describe.skipIf(!hasTestDb)("proposal e-signature flow (database)", () => {
  let t: TestDb;
  const fake = new FakeDocuSign();
  const ds = new DocuSignClient(cfg, fake.fetch as never);
  const files = new Map<string, Buffer>([["job-files-pricing/p.docx", Buffer.from("PK-docx")]]);
  const storage = { upload: async (b: string, p: string, d: Buffer) => void files.set(`${b}/${p}`, d), download: async (b: string, p: string) => files.get(`${b}/${p}`)! };
  let job: typeof s.jobs.$inferSelect;
  let doc: typeof s.documents.$inferSelect;

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    await createUser(t, "OWNER");
    [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "QUALIFIED" }).returning();
    [doc] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "PROPOSAL", title: "Proposal ESS-P1.docx", containsPricing: true, storageBucket: "job-files-pricing", storagePath: "p.docx" }).returning();
  });
  afterAll(async () => t?.close());

  it("sends the proposal with anchored signature/date tabs and a JSON webhook; job → Proposal Sent", async () => {
    const envelopeId = await sendProposalForSignature(t.db, doc.id, { ds, storage, webhookUrl: "https://crm.example/api/webhooks/docusign", signer: { name: "Pat Lee", email: "pat@example.com" } });
    type Env = {
      status: string;
      documents: Record<string, unknown>[];
      recipients: { signers: Record<string, unknown>[] };
      eventNotification: { eventData: Record<string, unknown> } & Record<string, unknown>;
    };
    const body = fake.envelopes.get(envelopeId)!.body as unknown as Env;
    expect(body.status).toBe("sent");
    expect(body.documents[0]).toMatchObject({ documentId: "1", name: "Proposal ESS-P1.docx", fileExtension: "docx", documentBase64: Buffer.from("PK-docx").toString("base64") });
    expect(body.recipients.signers[0]).toMatchObject({ email: "pat@example.com", name: "Pat Lee", tabs: { signHereTabs: [{ anchorString: SIGN_ANCHORS.signHere }], dateSignedTabs: [{ anchorString: SIGN_ANCHORS.dateSigned }] } });
    expect(body.eventNotification).toMatchObject({ url: "https://crm.example/api/webhooks/docusign", deliveryMode: "SIM", includeHMAC: "true", eventData: { version: "restv2.1" }, events: ["envelope-completed", "envelope-declined", "envelope-voided"] });
    expect(body.eventNotification.eventData.format).toBeUndefined(); // "Reserved for Docusign"
    const [d] = await t.db.select().from(s.documents).where(eq(s.documents.id, doc.id));
    expect(d).toMatchObject({ docusignEnvelopeId: envelopeId, docusignStatus: "sent", status: "SENT" });
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
    expect(j.stage).toBe("PROPOSAL_SENT");
    await expect(sendProposalForSignature(t.db, doc.id, { ds, storage, signer: { name: "x", email: "x@x.com" } })).rejects.toThrow(/already out for signature/);
  });

  it("webhook: HMAC required, duplicates ignored, re-fetches state; signed copy attached once; job → Signed", async () => {
    const envelopeId = "env-1";
    const raw = JSON.stringify({ event: "envelope-completed", apiVersion: "v2.1", generatedDateTime: "2026-09-25T14:00:01Z", data: { accountId: "acc-9", envelopeId } });
    expect((await acceptDocuSignWebhook(t.db, raw, new Headers(), cfg.hmacKeys)).status).toBe(401);
    expect((await acceptDocuSignWebhook(t.db, raw, sign(raw, "wrong"), cfg.hmacKeys)).status).toBe(401);

    // Out of order: the "completed" event arrives while DocuSign still reports "delivered" → nothing attached yet.
    fake.envelopes.get(envelopeId)!.status = "delivered";
    const first = await acceptDocuSignWebhook(t.db, raw, sign(raw), cfg.hmacKeys);
    expect(first).toMatchObject({ status: 200, envelopeId });
    expect(await acceptDocuSignWebhook(t.db, raw, sign(raw), cfg.hmacKeys)).toEqual({ status: 200 }); // duplicate body → no new delivery
    await runDocuSignDelivery(t.db, ds, storage, first.deliveryId!, envelopeId);
    let [d] = await t.db.select().from(s.documents).where(eq(s.documents.id, doc.id));
    expect(d).toMatchObject({ docusignStatus: "delivered", signedDocumentId: null });

    fake.envelopes.get(envelopeId)!.status = "completed";
    expect(await processEnvelope(t.db, ds, storage, envelopeId)).toBe("signed");
    expect(await processEnvelope(t.db, ds, storage, envelopeId)).toBe("already-signed");
    [d] = await t.db.select().from(s.documents).where(eq(s.documents.id, doc.id));
    expect(d).toMatchObject({ docusignStatus: "completed", status: "SIGNED" });
    const [signed] = await t.db.select().from(s.documents).where(eq(s.documents.id, d.signedDocumentId!));
    expect(signed).toMatchObject({ kind: "PROPOSAL", status: "SIGNED", containsPricing: true, storageBucket: "job-files-pricing", title: "Signed — Proposal ESS-P1.pdf" });
    expect(files.get(`job-files-pricing/${signed.storagePath}`)!.toString()).toBe("%PDF-1.7 signed");
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
    expect(j.stage).toBe("SIGNED");
    const acts = await t.db.select().from(s.activities).where(eq(s.activities.jobId, job.id));
    expect(acts.filter((a) => a.subject?.startsWith("Proposal signed"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.includes("/documents/combined"))).toHaveLength(1); // already attached → no second download
  });

  it("declined → one owner task; the proposal can be re-sent", async () => {
    const [d2] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "PROPOSAL", title: "P2.docx", containsPricing: true, storageBucket: "job-files-pricing", storagePath: "p.docx" }).returning();
    const env = await sendProposalForSignature(t.db, d2.id, { ds, storage, signer: { name: "Pat", email: "pat@example.com" } });
    fake.envelopes.get(env)!.status = "declined";
    expect(await processEnvelope(t.db, ds, storage, env)).toBe("declined");
    expect(await processEnvelope(t.db, ds, storage, env)).toBe("declined");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id));
    expect(tasks.filter((x) => x.title.startsWith("Proposal declined"))).toHaveLength(1);
    await expect(sendProposalForSignature(t.db, d2.id, { ds, storage, signer: { name: "Pat", email: "pat@example.com" } })).resolves.toMatch(/^env-/);
  });
});
