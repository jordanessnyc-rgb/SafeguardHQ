"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb, schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { freshbooksFromEnv } from "@/lib/integrations/freshbooks";
import { importFreshbooksClients, resolveImportedClient } from "@/lib/money/client-sync";
import { registerWebhooks } from "@/lib/money/freshbooks-setup";
import { siteOrigin } from "@/lib/site";

const PATH = "/settings/freshbooks";

function client() {
  const fb = freshbooksFromEnv(adminDb());
  if (!fb) throw new Error("Set FRESHBOOKS_CLIENT_ID, FRESHBOOKS_CLIENT_SECRET and FRESHBOOKS_REDIRECT_URI first.");
  return fb;
}

/** Pulls every active FreshBooks client into the review list. Never merges anything by itself. */
export async function importClients(_prev: ActionState): Promise<ActionState> {
  await requireOwner();
  const res = await safeAction(async () => {
    const counts = await importFreshbooksClients(adminDb(), client());
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { ok: true, message: `Imported ${total} FreshBooks clients: ${counts.PENDING ?? 0} to review, ${counts.LINKED ?? 0} already linked.` };
  });
  revalidatePath(PATH);
  return res;
}

/** Re-registers the webhooks (e.g. after the site URL changed). Idempotent. */
export async function reregisterWebhooks(_prev: ActionState): Promise<ActionState> {
  await requireOwner();
  const res = await safeAction(async () => {
    const cbs = await registerWebhooks(adminDb(), client(), `${siteOrigin(await headers())}/api/webhooks/freshbooks`);
    return { ok: true, message: `${Object.keys(cbs).length} webhooks registered. FreshBooks verifies each one within a minute.` };
  });
  revalidatePath(PATH);
  return res;
}

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), orgId: optionalUuid, contactId: optionalUuid }),
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("ignore") }),
]);

export async function resolveClient(fbId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const r = resolveSchema.parse(formObject(form));
    await user.db((tx) => resolveImportedClient(tx, fbId, r));
    return { ok: true, message: r.action === "ignore" ? "Ignored." : r.action === "create" ? "Created in the CRM." : "Linked." };
  });
  revalidatePath(PATH);
  return res;
}

/** Puts an ignored/linked row back in the review list (does not unlink the CRM record). */
export async function reopenClient(fbId: string) {
  const user = await requireOwner();
  await user.db((tx) => tx.update(s.freshbooksClients).set({ matchStatus: "PENDING" }).where(eq(s.freshbooksClients.freshbooksClientId, fbId)));
  revalidatePath(PATH);
}

/** Forgets the stored tokens. Invoices already in FreshBooks are untouched. */
export async function disconnectFreshbooks() {
  const user = await requireOwner();
  await user.db((tx) => tx.delete(s.freshbooksConnection).where(eq(s.freshbooksConnection.id, 1)));
  revalidatePath(PATH);
}
