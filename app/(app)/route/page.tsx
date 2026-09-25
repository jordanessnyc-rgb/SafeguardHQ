import Link from "next/link";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { legs, mapsUrl, OFFICE, orderStops, haversineMiles, estimateMinutes } from "@/lib/route/plan";
import { nyDate } from "@/lib/time";

export const metadata = { title: "Route" };

const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "—");

export default async function RoutePage({ searchParams }: PageProps<"/route">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const day = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : nyDate(new Date());
  const rows = await user.db((tx) =>
    tx
      .select({ id: s.jobs.id, jobNumber: s.jobs.jobNumber, serviceCode: s.jobs.serviceCode, scheduledAt: s.jobs.scheduledAt, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough, lat: s.properties.lat, lng: s.properties.lng })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(isNull(s.jobs.archivedAt), ne(s.jobs.stage, "LOST"), sql`(${s.jobs.scheduledAt} at time zone 'America/New_York')::date = ${day}::date`))
      .orderBy(s.jobs.scheduledAt),
  );
  const placed = rows.filter((r) => r.lat && r.lng);
  const unplaced = rows.filter((r) => !r.lat || !r.lng);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const stops = orderStops(
    placed.map((r) => ({ id: r.id, label: `${r.address}${r.unit ? `, Apt ${r.unit}` : ""}`, lat: Number(r.lat), lng: Number(r.lng) })),
    OFFICE,
    { returnToStart: true },
  );
  const plan = legs(stops);
  const back = stops.length ? haversineMiles(stops[stops.length - 1], OFFICE) : 0;
  const totalMiles = plan.reduce((n, l) => n + l.miles, 0) + back;
  const totalMin = plan.reduce((n, l) => n + l.minutes, 0) + (stops.length ? estimateMinutes(back) : 0);

  return (
    <>
      <PageHeader title="Route" description="A suggested order for the day's inspections — straight-line distances from the office, so drive times are rough estimates (no traffic)." />
      <form className="mb-4 flex items-end gap-2">
        <Input type="date" name="date" defaultValue={day} className="w-44" aria-label="Day" />
        <Button type="submit" variant="secondary">Show</Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>{new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</CardTitle>
          <CardDescription>
            {rows.length === 0 ? "Nothing scheduled." : `${stops.length} stop${stops.length === 1 ? "" : "s"} · about ${Math.round(totalMiles * 1.4)} road miles · about ${Math.floor(totalMin / 60)}h ${totalMin % 60}m driving, returning to the office`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {stops.length > 0 && (
            <>
              <ol className="space-y-2 text-sm">
                <li className="text-muted-foreground">Start: {OFFICE.label}</li>
                {plan.map((l, i) => {
                  const j = byId.get(l.stop.id)!;
                  return (
                    <li key={l.stop.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-2">
                      <span>
                        <span className="font-medium">{i + 1}. {l.stop.label}</span>
                        <span className="text-muted-foreground">{j.borough ? `, ${j.borough}` : ""} · {label(SERVICE_LABELS, j.serviceCode)} · <Link href={`/jobs/${j.id}`} className="font-mono text-xs underline">{j.jobNumber}</Link></span>
                      </span>
                      <span className="text-xs text-muted-foreground">booked {time(j.scheduledAt)} · ~{l.minutes} min from previous ({l.miles} mi)</span>
                    </li>
                  );
                })}
                <li className="text-muted-foreground">Back to the office (~{estimateMinutes(back)} min)</li>
              </ol>
              <a href={mapsUrl(stops)} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>Open in Google Maps</a>
              <p className="text-xs text-muted-foreground">If the suggested order differs from the booked times, reschedule on the job pages (clients are not notified automatically).</p>
            </>
          )}
          {unplaced.length > 0 && (
            <div className="text-sm">
              <div className="font-medium">Not on the map (no coordinates — open the property to resolve its address):</div>
              <ul className="list-disc pl-5">
                {unplaced.map((j) => <li key={j.id}><Link href={`/jobs/${j.id}`} className="underline">{j.jobNumber}</Link> · {j.address ?? "no property"} · booked {time(j.scheduledAt)}</li>)}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
