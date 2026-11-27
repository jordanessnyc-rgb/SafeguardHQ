import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { loadComposeData } from "@/lib/comms/compose-data";
import { LEFT_TABS, loadContactWorkspace, PANELS, type LeftTab, type Panel } from "@/lib/contacts/workspace";
import { stageNamer } from "@/lib/pipeline/config";
import { ContactWorkspaceView } from "./workspace-view";

/** Contact page: loads the person's workspace (RLS as the viewer) and renders the 3-column view. */
export default async function ContactPage({ params, searchParams }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireStaff();
  const tab: LeftTab = LEFT_TABS.find((t) => t === sp.tab) ?? "fields";
  const panel: Panel = PANELS.find((p) => p === sp.panel) ?? "notes";
  const noteSearch = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const now = new Date();
  const loaded = await user.db(async (tx) => {
    const data = await loadContactWorkspace(tx, id, { noteSearch, now });
    return data && { data, compose: await loadComposeData(tx), stageName: await stageNamer(tx) };
  });
  if (!loaded) notFound();
  return <ContactWorkspaceView id={id} {...loaded} viewer={{ role: user.role }} tab={tab} panel={panel} noteSearch={noteSearch} now={now} />;
}
