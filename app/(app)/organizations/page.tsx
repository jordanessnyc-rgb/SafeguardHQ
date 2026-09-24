import Link from "next/link";
import { and, asc, ilike, isNull, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { BRAND_LABELS, label, ORG_TYPE_LABELS } from "@/lib/labels";

export const metadata = { title: "Organizations" };

export default async function OrganizationsPage({ searchParams }: PageProps<"/organizations">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const rows = await user.db((tx) =>
    tx
      .select({
        id: s.organizations.id,
        name: s.organizations.name,
        type: s.organizations.type,
        brand: s.organizations.brand,
        contacts: sql<number>`(select count(*)::int from ${s.contacts} c where c.org_id = ${s.organizations.id} and c.archived_at is null)`,
        jobs: sql<number>`(select count(*)::int from ${s.jobs} j where j.client_org_id = ${s.organizations.id} and j.archived_at is null)`,
      })
      .from(s.organizations)
      .where(and(isNull(s.organizations.archivedAt), q ? ilike(s.organizations.name, `%${q}%`) : undefined))
      .orderBy(asc(s.organizations.name))
      .limit(300),
  );
  return (
    <>
      <PageHeader title="Organizations" actions={<Link href="/organizations/new" className={buttonVariants()}>New organization</Link>} />
      <form className="mb-4 max-w-sm">
        <Input name="q" defaultValue={q} placeholder="Search by name" />
      </form>
      {rows.length === 0 ? (
        <EmptyState>No organizations yet.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="hidden sm:table-cell">Brand</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => (
              <TableRow key={o.id}>
                <TableCell><Link className="font-medium hover:underline" href={`/organizations/${o.id}`}>{o.name}</Link></TableCell>
                <TableCell>{label(ORG_TYPE_LABELS, o.type)}</TableCell>
                <TableCell className="hidden sm:table-cell">{label(BRAND_LABELS, o.brand)}</TableCell>
                <TableCell className="text-right">{o.contacts}</TableCell>
                <TableCell className="text-right">{o.jobs}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
