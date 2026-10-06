import Link from "next/link";
import { col } from "@/lib/db/sql";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterForm } from "@/components/filter-form";
import { Pager } from "@/components/pager";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { personName } from "@/lib/labels";
import { listHref, PAGE_SIZE, pageFrom, pageWindow } from "@/lib/list";
import { formatPhone, toE164 } from "@/lib/phone";

export const metadata = { title: "People" };

const SORTS = [
  ["name", "Last name A–Z"],
  ["company", "Company"],
  ["jobs", "Most jobs"],
  ["newest", "Newest added"],
] as const;

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const sort = SORTS.find(([k]) => k === sp.sort)?.[0] ?? "name";
  const phone = toE164(q);
  const jobCount = sql<number>`(select count(*)::int from ${s.jobs} j where j.client_contact_id = ${col(s.contacts.id)} and j.archived_at is null)`;
  const where = and(
    isNull(s.contacts.archivedAt),
    q
      ? or(
          ilike(sql`coalesce(${s.contacts.firstName}, '') || ' ' || coalesce(${s.contacts.lastName}, '')`, `%${q}%`),
          sql`exists (select 1 from unnest(${s.contacts.emails}) e where e ilike ${`%${q}%`})`,
          phone ? sql`${phone} = any(${s.contacts.phones})` : undefined,
          ilike(s.organizations.name, `%${q}%`),
        )
      : undefined,
  );
  const order: SQL[] =
    sort === "company" ? [sql`${s.organizations.name} asc nulls last`] :
    sort === "jobs" ? [sql`${jobCount} desc`] :
    sort === "newest" ? [desc(s.contacts.createdAt)] :
    [];

  const { total, rows, win } = await user.db(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(s.contacts).leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId)).where(where);
    const win = pageWindow(n, pageFrom(sp.page));
    const rows = await tx
      .select({ c: s.contacts, orgName: s.organizations.name, jobs: jobCount })
      .from(s.contacts)
      .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
      .where(where)
      .orderBy(...order, sql`${s.contacts.lastName} asc nulls last`, asc(s.contacts.firstName), asc(s.contacts.id))
      .limit(PAGE_SIZE)
      .offset(win.offset);
    return { total: n, rows, win };
  });
  const href = (page: number) => listHref("/contacts", { q, sort: sort === "name" ? undefined : sort, page });

  return (
    <>
      <PageHeader title="People" actions={<Link href="/contacts/new" className={buttonVariants()}>New contact</Link>} />
      <FilterForm action="/contacts" className="mb-1">
        <Input type="search" name="q" defaultValue={q} placeholder="Search name, email, phone, or company" aria-label="Search contacts" className="w-full sm:w-72" />
        <NativeSelect name="sort" defaultValue={sort} aria-label="Sort by" className="w-auto">
          {SORTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
        {q && <Link href="/contacts" className="text-sm text-muted-foreground underline hover:text-foreground">Clear</Link>}
      </FilterForm>
      <Pager total={total} {...win} href={href} noun={total === 1 ? "contact" : "contacts"} />
      {rows.length === 0 ? (
        <EmptyState>{q ? "No contacts match." : "No contacts yet."}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Company</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Jobs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ c, orgName, jobs }) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link className="font-medium hover:underline" href={`/contacts/${c.id}`}>{personName(c)}</Link>
                  {c.doNotContact && <Badge variant="destructive" className="ml-2">Do not contact</Badge>}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {orgName && c.orgId ? <Link href={`/organizations/${c.orgId}`} className="hover:underline">{orgName}</Link> : "—"}
                </TableCell>
                <TableCell>{c.phones[0] ? <a href={`tel:${c.phones[0]}`}>{formatPhone(c.phones[0])}</a> : "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{c.emails[0] ? <a href={`mailto:${c.emails[0]}`} className="hover:underline">{c.emails[0]}</a> : "—"}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{jobs}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager total={total} {...win} href={href} noun="contacts" className="justify-end [&>span:first-child]:hidden" />
    </>
  );
}
