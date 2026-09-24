import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { encryptMember, expandFileName, getCase, listCases, networkFromCaseId } from "@/lib/airnyc/cases";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("AIRnyc helpers", () => {
  it("derives the network from the case ID prefix", () => {
    expect(networkFromCaseId("PHS_0148")).toBe("PHS");
    expect(networkFromCaseId("Emblem_0022")).toBe("EMBLEM");
    expect(networkFromCaseId("SIPPS_7")).toBe("SIPPS");
    expect(networkFromCaseId("NEWNET_1")).toBe("NEWNET");
  });
  it("expands checklist file names", () => {
    expect(expandFileName("{CASE_ID}_{LAST_NAME}_Report_{DATE}.pdf", { caseId: "PHS_0148", memberName: "Ana Lopez" }, new Date("2026-09-24T15:00:00Z"))).toBe(
      "PHS_0148_Lopez_Report_2026-09-24.pdf",
    );
  });
});

describe.skipIf(!hasTestDb)("AIRnyc cases (database)", () => {
  let t: TestDb;
  let va: TestUser;
  let owner: TestUser;
  let id: string;

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    t = await setupTestDb();
    va = await createUser(t, "VA");
    owner = await createUser(t, "OWNER");
    [{ id }] = await va.as((tx) =>
      tx
        .insert(s.airnycCases)
        .values({ caseId: "PHS_0148", network: "PHS", ...encryptMember({ memberName: "Ana Lopez", memberPhone: "+17185550100", address: "12 Elm St Apt 4B" }) })
        .returning(),
    );
  });
  afterAll(async () => t?.close());

  it("stores member fields only as ciphertext", async () => {
    const { rows } = await t.pool.query(`select * from airnyc_cases where id = $1`, [id]);
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain("Ana");
    expect(raw).not.toContain("7185550100");
    expect(raw).not.toContain("Elm");
  });

  it("decrypts for staff and writes an audit row per case read", async () => {
    const c = await va.as((tx) => getCase(tx, va.id, id));
    expect(c).toMatchObject({ caseId: "PHS_0148", memberName: "Ana Lopez", memberPhone: "+17185550100" });
    await va.as((tx) => listCases(tx, va.id));
    const audit = await owner.as((tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.entity, "airnyc_cases")));
    expect(audit.map((a) => [a.actor, a.action, a.entityId, (a.detail as { view: string }).view])).toEqual([
      [va.id, "READ", id, "detail"],
      [va.id, "READ", id, "list"],
    ]);
  });

  it("a user can't forge audit entries as someone else", async () => {
    await expect(
      va.as((tx) => tx.insert(s.auditLog).values({ actor: owner.id, action: "READ", entity: "airnyc_cases" })),
    ).rejects.toThrow();
  });

  it("users without an office role can't read cases", async () => {
    const field = await createUser(t, "FIELD");
    expect(await field.as((tx) => listCases(tx, field.id))).toEqual([]);
  });
});
