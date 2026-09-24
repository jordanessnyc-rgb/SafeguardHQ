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
      <PageHeader title="New job" description="Starts in the first stage of its service's pipeline. A Drive folder is created automatically when Drive is set up." />
      <ActionForm action={createJob} className="space-y-4">
        <JobFields options={options} job={{ propertyId: str("propertyId"), clientOrgId: str("clientOrgId"), clientContactId: str("clientContactId") }} />
        <SubmitButton>Create job</SubmitButton>
      </ActionForm>
    </div>
  );
}
