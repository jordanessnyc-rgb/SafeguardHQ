import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { fmtDate, label, SERVICE_LABELS, usd } from "@/lib/labels";
import { AGING_BUCKETS, arAging, CLIENT_TYPES, margins, type MarginRow } from "@/lib/money/reports";
import { nyDate } from "@/lib/money/digest";
import { fromNyInput } from "@/lib/time";

export const metadata = { title: "Reports" };

const CLIENT_TYPE_LABELS = { PRIVATE: "Private", MANAGEMENT_CO: "Management co.", AIRNYC: "AIRnyc", GOVERNMENT: "Government" } as const;
const ym = /^\d{4}-\d{2}$/;
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const user = await requireOwner(); // VAs are redirected; RLS would also return nothing
  const sp = await searchParams;
  const today = nyDate(new Date());
  const from = typeof sp.from === "string" && ym.test(sp.from) ? sp.from : `${today.slice(0, 4)}-01`;
  const to = typeof sp.to === "string" && ym.test(sp.to) && sp.to >= from ? sp.to : today.slice(0, 7);

  const { ar, m } = await user.db(async (tx) => ({
    ar: await arAging(tx),
    m: await margins(tx, { from: fromNyInput(`${from}-01T00:00`), to: fromNyInput(`${nextMonth(to)}-01T00:00`) }),
  }));

  return (
    <>
      <PageHeader title="Reports" description="Owner only. Figures come from FreshBooks (invoices, payments) and each job's financials." />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>A/R aging</CardTitle>
          <CardDescription>Outstanding on sent invoices, by client type and days past due. {usd(ar.total)} outstanding.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client type</TableHead>
                {AGING_BUCKETS.map((b) => <TableHead key={b} className="text-right">{b === "current" ? "Current" : `${b} days`}</TableHead>)}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CLIENT_TYPES.map((t) => (
                <TableRow key={t}>
                  <TableCell>{CLIENT_TYPE_LABELS[t]}</TableCell>
                  {AGING_BUCKETS.map((b) => (
                    <TableCell key={b} className={`text-right tabular-nums ${ar.grid[t][b] && (b === "61-90" || b === "90+") ? "text-destructive" : ""}`}>
                      {ar.grid[t][b] ? usd(ar.grid[t][b]) : "—"}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">{usd(AGING_BUCKETS.reduce((n, b) => n + ar.grid[t][b], 0))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                {AGING_BUCKETS.map((b) => <TableCell key={b} className="text-right tabular-nums">{usd(ar.totalsByBucket[b])}</TableCell>)}
                <TableCell className="text-right tabular-nums">{usd(ar.total)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>

          {ar.items.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Open invoices ({ar.items.length})</summary>
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ar.items.map((i) => (
                    <TableRow key={i.freshbooksInvoiceId}>
                      <TableCell>#{i.invoiceNumber ?? i.freshbooksInvoiceId}</TableCell>
                      <TableCell>
                        {i.client ?? "—"} <span className="text-xs text-muted-foreground">{CLIENT_TYPE_LABELS[i.clientType]}</span>
                      </TableCell>
                      <TableCell>{i.jobId ? <Link className="underline" href={`/jobs/${i.jobId}`}>{i.jobNumber}</Link> : "—"}</TableCell>
                      <TableCell>{i.dueAt ? fmtDate(i.dueAt) : "—"}</TableCell>
                      <TableCell>{i.bucket === "current" ? "current" : `${i.bucket} days`}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(i.outstanding)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Revenue &amp; margin</CardTitle>
          <CardDescription>
            Jobs delivered {monthName(from)} – {monthName(to)}. Revenue is the FreshBooks invoice amount, or the quoted amount before invoicing. Margin = revenue − sub − lab − other costs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form className="flex flex-wrap items-end gap-2 text-sm">
            <label className="grid gap-1">
              From <Input type="month" name="from" defaultValue={from} className="w-40" />
            </label>
            <label className="grid gap-1">
              To <Input type="month" name="to" defaultValue={to} className="w-40" />
            </label>
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
          <MarginTable title="By service" rows={m.byService} keyLabel={(k) => label(SERVICE_LABELS, k)} total={m.total} />
          <MarginTable title="By month" rows={m.byMonth} keyLabel={monthName} total={m.total} />
        </CardContent>
      </Card>
    </>
  );
}

function MarginTable({ title, rows, keyLabel, total }: { title: string; rows: MarginRow[]; keyLabel: (k: string) => string; total: MarginRow }) {
  const cells = (r: MarginRow) => (
    <>
      <TableCell className="text-right tabular-nums">{r.jobs}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(r.revenue)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(r.subCost)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(r.labCost)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(r.otherCost)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(r.margin)}</TableCell>
      <TableCell className="text-right tabular-nums">{r.marginPct == null ? "—" : `${r.marginPct}%`}</TableCell>
    </>
  );
  return (
    <div>
      <div className="mb-1 text-sm font-medium">{title}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No delivered jobs in this range.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead className="text-right">Jobs</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Sub cost</TableHead>
              <TableHead className="text-right">Lab cost</TableHead>
              <TableHead className="text-right">Other</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>{keyLabel(r.key)}</TableCell>
                {cells(r)}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              {cells(total)}
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </div>
  );
}
