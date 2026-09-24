import { eq } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { driveFromEnv, jobFolderName, type DriveClient } from "@/lib/integrations/google-drive";

export type DriveOutcome = { url?: string; skipped?: string };

/** Creates the job's Drive folder from the template (SPEC §6.4). Safe to call repeatedly. */
export async function ensureJobDriveFolder(tx: Tx, jobId: string, drive: DriveClient | null = driveFromEnv()): Promise<DriveOutcome> {
  const [row] = await tx
    .select({ job: s.jobs, address: s.properties.addressLine, unit: s.properties.unit, lastName: s.contacts.lastName, orgName: s.organizations.name })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .where(eq(s.jobs.id, jobId));
  if (!row) throw new Error("Job not found");
  if (row.job.driveFolderUrl) return { url: row.job.driveFolderUrl };
  if (!drive) return { skipped: "Google Drive isn't configured (see docs/RUNBOOK.md)." };

  const [cfg] = await tx.select().from(s.settings);
  if (!cfg?.driveJobsParentFolderId) return { skipped: "Set the Drive jobs parent folder in Settings." };

  const address = [row.address, row.unit && `Apt ${row.unit}`].filter(Boolean).join(" ");
  const folder = await drive.ensureFolderFromTemplate({
    name: jobFolderName(row.job.jobNumber, row.lastName ?? row.orgName, address),
    parentId: cfg.driveJobsParentFolderId,
    templateId: cfg.driveTemplateFolderId,
  });
  await tx.update(s.jobs).set({ driveFolderUrl: folder.url, driveFolderId: folder.id }).where(eq(s.jobs.id, jobId));
  return { url: folder.url };
}
