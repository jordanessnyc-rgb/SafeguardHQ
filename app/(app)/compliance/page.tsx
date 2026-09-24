import Link from "next/link";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { addDays, upcomingCycles } from "@/lib/compliance/cycles";
import { daysUntil } from "@/lib/compliance/expiry";
import { fmtDate, label, SERVICE_LABELS } from "@/lib/labels";
import { nyDate } from "@/lib/time";
import { archiveCredential, saveCredential, saveRule } from "./actions";

export const metadata = { title: "Compliance" };

const BOROUGHS = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
const RANGES = { "3": "Next 3 months", "12": "Next 12 months", "36": "Next 3 years" } as const;
const monthName = (iso: string) => new Date(`${iso.slice(0, 7)}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function DaysLeft({ date }: { date: string | null }) {
  if (!date) return <span className="text-xs text-muted-foreground">no date</span>;
  const d = daysUntil(date, new Date());
  const tone = d < 0 ? "destructive" : d <= 30 ? "default" : "secondary";
  return <Badge variant={tone}>{d < 0 ? `expired ${-d}d ago` : d === 0 ? "today" : `${d} days`}</Badge>;
}

export default async function CompliancePage({ searchParams }: PageProps<"/compliance">) {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const sp = await searchParams;
  const orgId = typeof sp.org === "string" && sp.org ? sp.org : undefined;
  const borough = typeof sp.borough === "string" && BOROUGHS.includes(sp.borough) ? sp.borough : undefined;
  const range = typeof sp.range === "string" && sp.range in RANGES ? (sp.range as keyof typeof RANGES) : "12";
  const today = nyDate(new Date());

  const d = await user.db(async (tx) => ({
    cycles: await upcomingCycles(tx, addDays(today, -90), addDays(today, Number(range) * 31), { orgId, borough }),
    orgs: await tx
      .selectDistinct({ id: s.organizations.id, name: s.organizations.name })
      .from(s.organizations)
      .innerJoin(s.jobs, and(eq(s.jobs.clientOrgId, s.organizations.id), isNotNull(s.jobs.nextCycleDue)))
      .orderBy(asc(s.organizations.name)),
    rules: await tx.select().from(s.complianceRules).where(isNull(s.complianceRules.archivedAt)),
    creds: await tx.select().from(s.credentials).where(isNull(s.credentials.archivedAt)).orderBy(asc(s.credentials.name)),
    subs: await tx
      .select({ orgId: s.subProfiles.orgId, name: s.organizations.name, expires: s.subProfiles.insuranceExpires, trades: s.subProfiles.trades })
      .from(s.subProfiles)
      .innerJoin(s.organizations, eq(s.organizations.id, s.subProfiles.orgId))
      .where(isNull(s.organizations.archivedAt))
      .orderBy(asc(s.subProfiles.insuranceExpires)),
  }));
  const ruleFor = new Map(d.rules.map((r) => [r.serviceCode, r]));
  const byMonth = new Map<string, typeof d.cycles>();
  for (const c of d.cycles) byMonth.set(c.due.slice(0, 7), [...(byMonth.get(c.due.slice(0, 7)) ?? []), c]);

  return (
    <>
      <PageHeader title="Compliance" description="Recurring inspection cycles, ESS licenses and subcontractor insurance." />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Upcoming cycles</CardTitle>
          <CardDescription>Jobs whose next compliance cycle is due (overdue ones from the last 90 days included). Outreach tasks are created at each rule&apos;s lead time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="flex flex-wrap items-end gap-2 text-sm">
            <NativeSelect name="org" defaultValue={orgId ?? ""} className="w-56" aria-label="Client">
              <option value="">All clients</option>
              {d.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </NativeSelect>
            <NativeSelect name="borough" defaultValue={borough ?? ""} className="w-44" aria-label="Borough">
              <option value="">All boroughs</option>
              {BOROUGHS.map((b) => <option key={b}>{b}</option>)}
            </NativeSelect>
            <NativeSelect name="range" defaultValue={range} className="w-44" aria-label="Range">
              {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </NativeSelect>
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
          {d.cycles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No cycles in this range. {d.rules.length === 0 && "Add a cycle rule below — dates are computed when a job is Closed."}
            </p>
          ) : (
            [...byMonth].map(([month, items]) => (
              <div key={month}>
                <div className="mb-1 text-sm font-medium">{monthName(month)}</div>
                <ul className="divide-y rounded-md border text-sm">
                  {items.map((c) => (
                    <li key={c.jobId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span>
                        <span className={c.due < today ? "font-medium text-destructive" : "font-medium"}>{fmtDate(c.due)}</span> · {label(SERVICE_LABELS, c.serviceCode)} · {c.client ?? "no client"}
                        {c.address && <span className="text-muted-foreground"> · {c.address}{c.borough ? `, ${c.borough}` : ""}</span>}
                      </span>
                      <Link href={`/jobs/${c.jobId}`} className="font-mono text-xs underline">{c.jobNumber}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="licenses">
          <CardHeader>
            <CardTitle>ESS licenses</CardTitle>
            <CardDescription>Alerts go to the owner 60, 30 and 7 days before expiry, and on expiry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {d.creds.map((c) => (
              <div key={c.id} className="rounded-lg border p-2">
                <ActionForm action={saveCredential.bind(null, c.id)} className="grid gap-2 sm:grid-cols-2">
                  <fieldset disabled={!isOwner} className="contents">
                    <Input name="name" defaultValue={c.name} aria-label="Name" />
                    <Input name="number" defaultValue={c.number ?? ""} placeholder="License #" aria-label="Number" />
                    <Input name="issuer" defaultValue={c.issuer ?? ""} placeholder="Issuer" aria-label="Issuer" />
                    <div className="flex items-center gap-2">
                      <Input name="expiresAt" type="date" defaultValue={c.expiresAt ?? ""} aria-label="Expires" />
                      <DaysLeft date={c.expiresAt} />
                    </div>
                    {isOwner && <div><SubmitButton size="xs" variant="secondary">Save</SubmitButton></div>}
                  </fieldset>
                </ActionForm>
                {isOwner && (
                  <form action={archiveCredential.bind(null, c.id)} className="text-right">
                    <Button size="xs" variant="ghost" type="submit">Remove</Button>
                  </form>
                )}
              </div>
            ))}
            {isOwner && (
              <ActionForm action={saveCredential.bind(null, null)} className="grid gap-2 rounded-lg border border-dashed p-2 sm:grid-cols-2">
                <Input name="name" placeholder="License / certification" required />
                <Input name="number" placeholder="License #" />
                <Input name="issuer" placeholder="Issuer" />
                <Input name="expiresAt" type="date" aria-label="Expires" />
                <div><SubmitButton size="xs">Add license</SubmitButton></div>
              </ActionForm>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subcontractor insurance</CardTitle>
            <CardDescription>COI dates are kept on each subcontractor&apos;s organization page.</CardDescription>
          </CardHeader>
          <CardContent>
            {d.subs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No subcontractor details yet. Open a Subcontractor organization to add its COI date.</p>
            ) : (
              <ul className="divide-y text-sm">
                {d.subs.map((x) => (
                  <li key={x.orgId} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      <Link href={`/organizations/${x.orgId}`} className="underline">{x.name}</Link>
                      {x.trades.length > 0 && <span className="text-xs text-muted-foreground"> · {x.trades.join(", ")}</span>}
                    </span>
                    <span className="flex items-center gap-2 text-xs">{x.expires && fmtDate(x.expires)} <DaysLeft date={x.expires} /></span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Cycle rules</CardTitle>
          <CardDescription>
            Entered by Jordan — the CRM never assumes a legal cycle. When a job is Closed, its next cycle = inspection date + months, and an outreach task is created “lead time” days before. Leave months blank for cycles that need a date set by hand.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead className="w-28">Cycle (months)</TableHead>
                <TableHead className="w-28">Lead time (days)</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.serviceCodeEnum.enumValues.filter((c) => c !== "BID").map((code) => {
                const r = ruleFor.get(code);
                return (
                  <TableRow key={code}>
                    <TableCell className="whitespace-normal">{label(SERVICE_LABELS, code)}</TableCell>
                    <TableCell colSpan={5} className="p-0">
                      <ActionForm action={saveRule} className="grid grid-cols-[7rem_7rem_1fr_5rem_5rem] items-center gap-2 p-2">
                        <fieldset disabled={!isOwner} className="contents">
                          <input type="hidden" name="serviceCode" value={code} />
                          <Input name="cycleMonths" inputMode="numeric" defaultValue={r?.cycleMonths ?? ""} placeholder="—" aria-label="Cycle months" />
                          <Input name="leadTimeDays" inputMode="numeric" defaultValue={r?.leadTimeDays ?? 60} aria-label="Lead time days" />
                          <Input name="notes" defaultValue={r?.notes ?? ""} placeholder={r ? "" : "No rule yet"} aria-label="Notes" />
                          <input type="checkbox" name="active" defaultChecked={r?.active ?? true} className="size-4 accent-primary" aria-label="Active" />
                          {isOwner ? <SubmitButton size="xs" variant={r ? "secondary" : "default"}>{r ? "Save" : "Add"}</SubmitButton> : <span />}
                        </fieldset>
                      </ActionForm>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
