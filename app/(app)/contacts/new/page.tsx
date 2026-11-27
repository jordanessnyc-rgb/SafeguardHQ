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
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 200) : undefined);
  const orgId = str(sp.orgId);
  // Messages → "Add as contact" pre-fills what the message already tells us.
  const prefill = { firstName: str(sp.firstName) ?? null, lastName: str(sp.lastName) ?? null, emails: str(sp.email) ? [str(sp.email)!] : [], phones: str(sp.phone) ? [str(sp.phone)!] : [] };
  const orgs = await user.db((tx) =>
    tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name)),
  );
  return (
    <div className="max-w-2xl">
      <PageHeader title="New contact" />
      <ActionForm action={createContact} className="space-y-4">
        <ContactFields orgs={orgs} contact={{ orgId: orgId ?? null, ...prefill }} />
        <SubmitButton>Create contact</SubmitButton>
      </ActionForm>
    </div>
  );
}
