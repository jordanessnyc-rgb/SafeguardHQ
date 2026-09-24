import Link from "next/link";
import { and, desc, ilike, isNull, or, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";

export const metadata = { title: "Properties" };

export default async function PropertiesPage({ searchParams }: PageProps<"/properties">) {
  const user = await requireStaff();
  const q = typeof (await searchParams).q === "string" ? String((await searchParams).q).trim() : "";
  const openCount = sql<number>`(select count(*)::int from ${s.propertyViolations} v where v.property_id = ${s.properties.id} and v.is_open)`;
  const rows = await user.db((tx) =>
    tx
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
      })
      .from(s.properties)
      .where(
        and(
          isNull(s.properties.archivedAt),
          q ? or(ilike(s.properties.addressLine, `%${q}%`), ilike(s.properties.bbl, `${q}%`), ilike(s.properties.ownerName, `%${q}%`)) : undefined,
        ),
      )
      .orderBy(desc(s.properties.createdAt))
      .limit(200),
  );

  return (
    <>
      <PageHeader
        title="Properties"
        description="Every job hangs off a property."
        actions={<Link href="/properties/new" className={buttonVariants()}>New property</Link>}
      />
      <form className="mb-4 max-w-sm">
        <Input name="q" defaultValue={q} placeholder="Search address, BBL, or owner" />
      </form>
      {rows.length === 0 ? (
        <EmptyState>No properties yet. Create one from an address.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead className="hidden sm:table-cell">BBL</TableHead>
              <TableHead className="hidden md:table-cell">Owner (PLUTO)</TableHead>
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
                    {p.enrichmentStatus !== "OK" && <Badge variant="outline" className="ml-2">Data {p.enrichmentStatus.toLowerCase()}</Badge>}
                  </div>
                </TableCell>
                <TableCell className="hidden font-mono text-xs sm:table-cell">{p.bbl ?? "unresolved"}</TableCell>
                <TableCell className="hidden max-w-60 truncate md:table-cell">{p.ownerName ?? "—"}</TableCell>
                <TableCell className="text-right">{p.openViolations}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
