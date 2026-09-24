import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { loadJobOptions } from "@/lib/jobs/options";
import { createCase } from "../actions";
import { CaseFields } from "../case-fields";

export const metadata = { title: "New AIRnyc case" };

export default async function NewCasePage() {
  const user = await requireStaff();
  const { properties } = await user.db(loadJobOptions);
  return (
    <div className="max-w-3xl">
      <PageHeader title="New AIRnyc case" description="Manual entry (AIRnyc mode: MANUAL)." />
      <ActionForm action={createCase} className="space-y-4">
        <CaseFields properties={properties} />
        <SubmitButton>Create case</SubmitButton>
      </ActionForm>
    </div>
  );
}
