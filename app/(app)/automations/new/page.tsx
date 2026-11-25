import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { editorOptions } from "@/lib/automation/describe";
import { saveWorkflow } from "../actions";
import { WorkflowEditor } from "../workflow-editor";

export const metadata = { title: "New workflow" };

export default async function NewWorkflowPage() {
  const user = await requireOwner();
  const options = await user.db((tx) => editorOptions(tx));
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-xs text-muted-foreground">
        <Link href="/automations" className="hover:underline">Automations</Link> / New
      </nav>
      <PageHeader title="New workflow" description="Saved workflows start switched off. Switch it on when it looks right." />
      <WorkflowEditor
        action={saveWorkflow.bind(null, null)}
        canEdit
        options={options}
        initial={{ name: "", description: "", autoSend: false, trigger: { type: "JOB_STAGE_ENTERED", stage: options.stages.find((st) => st.key === "SCHEDULED")?.key ?? options.stages[0]?.key ?? "" }, conditions: [], steps: [{ type: "SEND_EMAIL", subject: "Your inspection at {{address}}", body: "Hi {{first_name}},\n\nThis confirms your inspection at {{address}} on {{scheduled_date}} at {{scheduled_time}}.\n\n{{brand_name}} · {{brand_phone}}" }] }}
      />
    </>
  );
}
