import { eq } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { airnycFolderName, driveFromEnv, type DriveClient } from "@/lib/integrations/google-drive";
import { getCase, lastNameOf } from "./cases";

/** {AIRNYC_ID}_{LastName}_{Address} folder under the AIRnyc parent (SPEC §6.4). */
export async function ensureCaseDriveFolder(tx: Tx, actor: string, id: string, drive: DriveClient | null = driveFromEnv()) {
  const c = await getCase(tx, actor, id);
  if (!c) throw new Error("Case not found");
  if (c.driveFolderUrl) return { url: c.driveFolderUrl };
  if (!drive) return { skipped: "Google Drive isn't configured (see docs/RUNBOOK.md)." };
  const [cfg] = await tx.select().from(s.settings);
  if (!cfg?.driveAirnycParentFolderId) return { skipped: "Set the Drive AIRnyc parent folder in Settings." };
  const folder = await drive.ensureFolderFromTemplate({
    name: airnycFolderName(c.caseId, lastNameOf(c.memberName), c.address),
    parentId: cfg.driveAirnycParentFolderId,
    templateId: cfg.driveTemplateFolderId,
  });
  await tx.update(s.airnycCases).set({ driveFolderUrl: folder.url, driveFolderId: folder.id }).where(eq(s.airnycCases.id, id));
  return { url: folder.url };
}
