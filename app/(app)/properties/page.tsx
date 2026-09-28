import Link from "next/link";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterForm } from "@/components/filter-form";
import { Pager } from "@/components/pager";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { listHref, PAGE_SIZE, pageFrom, pageWindow } from "@/lib/list";

export const metadata = { title: "Properties" };

const SORTS = [
  ["address", "Address A–Z"],
  ["recent", "Most recent job"],
  ["jobs", "Most jobs"],
  ["violations", "Most open violations"],
  ["newest", "Newest added"],
] as const;
const SHOW = [
  ["", "All properties"],
  ["unmatched", "Not matched to an NYC building"],
  ["violations", "With open violations"],
  ["nycha", "NYCHA"],
] as const;

export default async function PropertiesPage({ searchParams }: PageProps<"/properties">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const sort = SORTS.find(([k]) => k === sp.sort)?.[0] ?? "address";
  const show = SHOW.find(([k]) => k === sp.show)?.[0] ?? "";
  const openCount = sql<number>`(select count(*)::int from ${s.propertyViolations} v where v.property_id = ${s.properties.id} and v.is_open)`;
  const jobCount = sql<number>`(select count(*)::int from ${s.jobs} j where j.property_id = ${s.properties.id} and j.archived_at is null)`;
  const lastJob = sql<Date | null>`(select max(coalesce(j.delivered_at, j.created_at)) from ${s.jobs} j where j.property_id = ${s.properties.id} and j.archived_at is null)`;

  const where = and(
    isNull(s.properties.archivedAt),
    q ? or(ilike(s.properties.addressLine, `%${q}%`), ilike(s.properties.bbl, `${q}%`), ilike(s.properties.ownerName, `%${q}%`), ilike(s.properties.zip, `${q}%`)) : undefined,
    show === "unmatched" ? isNull(s.properties.bbl) : undefined,
    show === "violations" ? sql`${openCount} > 0` : undefined,
    show === "nycha" ? eq(s.properties.isNycha, true) : undefined,
  );
  const order: SQL[] =
    sort === "recent" ? [sql`${lastJob} desc nulls last`] :
    sort === "jobs" ? [sql`${jobCount} desc`] :
    sort === "violations" ? [sql`${openCount} desc`] :
    sort === "newest" ? [desc(s.properties.createdAt)] :
    [];

  const { total, rows, win } = await user.db(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(s.properties).where(where);
    const win = pageWindow(n, pageFrom(sp.page));
    const rows = await tx
      .select({
        id: s.properties.id,
        addressLine: s.properties.addressLine,
        unit: s.properties.unit,
        borough: s.properties.borough,
        bbl: s.properties.bbl,
        isNycha: s.properties.isNycha,
        ownerName: s.properties.ownerName,
        enrichmentStatus: s.properties.enrichmentStatus,
        openViolations: openCount,
        jobs: jobCount,
        lastJob,
      })
      .from(s.properties)
      .where(where)
      .orderBy(...order, asc(s.properties.addressLine), asc(s.properties.unit), asc(s.properties.id))
      .limit(PAGE_SIZE)
      .offset(win.offset);
    return { total: n, rows, win };
  });
  const href = (page: number) => listHref("/properties", { q, sort: sort === "address" ? undefined : sort, show, page });
  const filtered = Boolean(q || show);

  return (
    <>
      <PageHeader
        title="Properties"
        description="Every job hangs off a property."
        actions={<Link href="/properties/new" className={buttonVariants()}>New property</Link>}
      />
      <FilterForm action="/properties" className="mb-1">
        <Input type="search" name="q" defaultValue={q} placeholder="Search address, ZIP, BBL, or owner" aria-label="Search properties" className="w-full sm:w-72" />
        <NativeSelect name="show" defaultValue={show} aria-label="Show" className="w-auto">
          {SHOW.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
        <NativeSelect name="sort" defaultValue={sort} aria-label="Sort by" className="w-auto">
          {SORTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
        {filtered && <Link href="/properties" className="text-sm text-muted-foreground underline hover:text-foreground">Clear</Link>}
      </FilterForm>
      <Pager total={total} {...win} href={href} noun={total === 1 ? "property" : "properties"} />
      {rows.length === 0 ? (
        <EmptyState>{filtered ? "No properties match." : "No properties yet. Create one from an address."}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead className="hidden sm:table-cell">BBL</TableHead>
              <TableHead className="hidden md:table-cell">Owner (city records)</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Last job</TableHead>
              <TableHead className="text-right">Open violations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link href={`/properties/${p.id}`} className="font-medium hover:underline">
                    {p.addressLine}
                    {p.unit ? `, #${p.unit}` : ""}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {p.borough}
                    {p.isNycha && <Badge variant="destructive" className="ml-2">NYCHA</Badge>}
                    {!p.bbl && <Badge variant="outline" className="ml-2">Check address</Badge>}
                  </div>
                </TableCell>
                <TableCell className="hidden font-mono text-xs sm:table-cell">{p.bbl ?? "—"}</TableCell>
                <TableCell className="hidden max-w-60 truncate md:table-cell">{p.ownerName ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{p.jobs}</TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">{p.lastJob ? fmtDate(new Date(p.lastJob)) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{p.openViolations}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager total={total} {...win} href={href} noun={total === 1 ? "property" : "properties"} className="justify-end [&>span:first-child]:hidden" />
    </>
  );
}
