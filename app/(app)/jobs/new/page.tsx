import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { loadJobOptions } from "@/lib/jobs/options";
import { createJob } from "../actions";
import { JobFields } from "../job-fields";

export const metadata = { title: "New job" };

export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const options = await user.db(loadJobOptions);
  return (
    <div className="max-w-3xl">
      <PageHeader title="New job" description="Capture the request now. You can add scheduling, assignment, and other details later." />
      <ActionForm action={createJob} className="space-y-4">
        <JobFields options={options} job={{ propertyId: str("propertyId"), clientOrgId: str("clientOrgId"), clientContactId: str("clientContactId") }} />
        <div className="flex items-center gap-3"><SubmitButton>Create job</SubmitButton><span className="text-xs text-muted-foreground">Creates a record. No client message is sent.</span></div>
      </ActionForm>
    </div>
  );
}
