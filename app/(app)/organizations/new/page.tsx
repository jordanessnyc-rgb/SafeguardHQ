import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { createOrganization } from "../actions";
import { OrgFields } from "../org-fields";

export const metadata = { title: "New organization" };

export default async function NewOrgPage() {
  await requireStaff();
  return (
    <div className="max-w-2xl">
      <PageHeader title="New organization" />
      <ActionForm action={createOrganization} className="space-y-4">
        <OrgFields />
        <SubmitButton>Create organization</SubmitButton>
      </ActionForm>
    </div>
  );
}
