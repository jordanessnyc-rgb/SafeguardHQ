import { asc, isNull } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { createContact } from "../actions";
import { ContactFields } from "../contact-fields";

export const metadata = { title: "New contact" };

export default async function NewContactPage({ searchParams }: PageProps<"/contacts/new">) {
  const user = await requireStaff();
  const { orgId } = await searchParams;
  const orgs = await user.db((tx) =>
    tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name)),
  );
  return (
    <div className="max-w-2xl">
      <PageHeader title="New contact" />
      <ActionForm action={createContact} className="space-y-4">
        <ContactFields orgs={orgs} contact={{ orgId: typeof orgId === "string" ? orgId : null }} />
        <SubmitButton>Create contact</SubmitButton>
      </ActionForm>
    </div>
  );
}
