import Link from "next/link";
import { col } from "@/lib/db/sql";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterForm } from "@/components/filter-form";
import { Pager } from "@/components/pager";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { BRAND_LABELS, label, ORG_TYPE_LABELS } from "@/lib/labels";
import { listHref, PAGE_SIZE, pageFrom, pageWindow } from "@/lib/list";

export const metadata = { title: "Companies" };

const SORTS = [
  ["name", "Name A–Z"],
  ["jobs", "Most jobs"],
  ["buildings", "Most buildings"],
  ["newest", "Newest added"],
] as const;

export default async function OrganizationsPage({ searchParams }: PageProps<"/organizations">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const sort = SORTS.find(([k]) => k === sp.sort)?.[0] ?? "name";
  const type = s.organizations.type.enumValues.find((v) => v === sp.type) ?? "";
  const contacts = sql<number>`(select count(*)::int from ${s.contacts} c where c.org_id = ${col(s.organizations.id)} and c.archived_at is null)`;
  const jobs = sql<number>`(select count(*)::int from ${s.jobs} j where j.client_org_id = ${col(s.organizations.id)} and j.archived_at is null)`;
  const buildings = sql<number>`(select count(distinct r.property_id)::int from ${s.propertyRoles} r where r.org_id = ${col(s.organizations.id)} and r.active)`;
  const where = and(
    isNull(s.organizations.archivedAt),
    q ? or(ilike(s.organizations.name, `%${q}%`), ilike(s.organizations.email, `%${q}%`)) : undefined,
    type ? eq(s.organizations.type, type) : undefined,
  );
  const order: SQL[] =
    sort === "jobs" ? [sql`${jobs} desc`] :
    sort === "buildings" ? [sql`${buildings} desc`] :
    sort === "newest" ? [desc(s.organizations.createdAt)] :
    [];

  const { total, rows, win } = await user.db(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(s.organizations).where(where);
    const win = pageWindow(n, pageFrom(sp.page));
    const rows = await tx
      .select({ id: s.organizations.id, name: s.organizations.name, type: s.organizations.type, brand: s.organizations.brand, contacts, jobs, buildings })
      .from(s.organizations)
      .where(where)
      .orderBy(...order, asc(s.organizations.name), asc(s.organizations.id))
      .limit(PAGE_SIZE)
      .offset(win.offset);
    return { total: n, rows, win };
  });
  const href = (page: number) => listHref("/organizations", { q, type, sort: sort === "name" ? undefined : sort, page });
  const filtered = Boolean(q || type);

  return (
    <>
      <PageHeader title="Companies" actions={<Link href="/organizations/new" className={buttonVariants()}>New organization</Link>} />
      <FilterForm action="/organizations" className="mb-1">
        <Input type="search" name="q" defaultValue={q} placeholder="Search name or email" aria-label="Search organizations" className="w-full sm:w-72" />
        <NativeSelect name="type" defaultValue={type} aria-label="Type" className="w-auto">
          <option value="">All types</option>
          {Object.entries(ORG_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
        <NativeSelect name="sort" defaultValue={sort} aria-label="Sort by" className="w-auto">
          {SORTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
        {filtered && <Link href="/organizations" className="text-sm text-muted-foreground underline hover:text-foreground">Clear</Link>}
      </FilterForm>
      <Pager total={total} {...win} href={href} noun={total === 1 ? "organization" : "organizations"} />
      {rows.length === 0 ? (
        <EmptyState>{filtered ? "No organizations match." : "No organizations yet."}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="hidden sm:table-cell">Brand</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Contacts</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Buildings</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => (
              <TableRow key={o.id}>
                <TableCell><Link className="font-medium hover:underline" href={`/organizations/${o.id}`}>{o.name}</Link></TableCell>
                <TableCell>{label(ORG_TYPE_LABELS, o.type)}</TableCell>
                <TableCell className="hidden sm:table-cell">{label(BRAND_LABELS, o.brand)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{o.contacts}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{o.buildings}</TableCell>
                <TableCell className="text-right tabular-nums">{o.jobs}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager total={total} {...win} href={href} noun="organizations" className="justify-end [&>span:first-child]:hidden" />
    </>
  );
}
