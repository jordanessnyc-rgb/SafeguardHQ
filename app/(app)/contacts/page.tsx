import Link from "next/link";
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { personName } from "@/lib/labels";
import { formatPhone, toE164 } from "@/lib/phone";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const phone = toE164(q);
  const rows = await user.db((tx) =>
    tx
      .select({ c: s.contacts, orgName: s.organizations.name })
      .from(s.contacts)
      .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
      .where(
        and(
          isNull(s.contacts.archivedAt),
          q
            ? or(
                ilike(sql`coalesce(${s.contacts.firstName}, '') || ' ' || coalesce(${s.contacts.lastName}, '')`, `%${q}%`),
                sql`exists (select 1 from unnest(${s.contacts.emails}) e where e ilike ${`%${q}%`})`,
                phone ? sql`${phone} = any(${s.contacts.phones})` : undefined,
                ilike(s.organizations.name, `%${q}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(s.contacts.lastName), asc(s.contacts.firstName))
      .limit(300),
  );
  return (
    <>
      <PageHeader title="Contacts" actions={<Link href="/contacts/new" className={buttonVariants()}>New contact</Link>} />
      <form className="mb-4 max-w-sm">
        <Input name="q" defaultValue={q} placeholder="Search name, email, phone, or company" />
      </form>
      {rows.length === 0 ? (
        <EmptyState>No contacts found.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Organization</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ c, orgName }) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link className="font-medium hover:underline" href={`/contacts/${c.id}`}>{personName(c)}</Link>
                  {c.doNotContact && <Badge variant="destructive" className="ml-2">DNC</Badge>}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{orgName ?? "—"}</TableCell>
                <TableCell>{c.phones[0] ? <a href={`tel:${c.phones[0]}`}>{formatPhone(c.phones[0])}</a> : "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{c.emails[0] ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
