/**
 * Daily digest (SPEC §9.7): weekday morning email + short SMS to Jordan. Internal only — goes to
 * settings.digest_recipients and the owner's alert phone, never to clients.
 *
 * Sections: stale jobs, lab results waiting, unpaid invoices by age, going-cold leads, expiring
 * licenses/COIs, compliance cycles coming due, bids due within 7 days, overdue tasks.
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type { MailSender } from "@/lib/comms/outbound";
import type { QuoClient } from "@/lib/integrations/quo";
import { fmtDate, personName } from "@/lib/labels";
import { daysInStage, isStale } from "@/lib/pipeline/rules";
import { nyDate, TZ } from "@/lib/time";
import { expiringItems, type Expiring } from "@/lib/compliance/expiry";
import { addDays, upcomingCycles, type UpcomingCycle } from "@/lib/compliance/cycles";
import { arAging, type AgingBucket } from "./reports";

type Conn = Db | Tx;

export type Digest = {
  date: string; // YYYY-MM-DD, New York
  staleJobs: { jobNumber: string; stage: string; days: number; address: string | null }[];
  labWaiting: { jobNumber: string; samples: number; stage: string }[];
  unpaid: { total: number; byBucket: Record<AgingBucket, number>; worst: { invoiceNumber: string | null; client: string | null; outstanding: number; bucket: string }[] };
  goingCold: { name: string; phoneOrEmail: string | null; lastInbound: Date; channel: string }[];
  expiring: Expiring[];
  cyclesDue: UpcomingCycle[];
  bidsDue: { title: string; agency: string | null; dueAt: Date; status: string; recommendation: string | null }[];
  overdueTasks: number;
};

export { nyDate } from "@/lib/time";

export async function buildDigest(conn: Conn, now = new Date()): Promise<Digest> {
  // --- stale jobs ---
  const stages = await conn.select().from(s.pipelineStages);
  const stageMap = new Map(stages.map((st) => [`${st.pipelineKey}:${st.key}`, st]));
  const open = await conn
    .select({ job: s.jobs, address: s.properties.addressLine })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(isNull(s.jobs.archivedAt));
  const staleJobs = open
    .filter(({ job }) => {
      const st = stageMap.get(`${job.pipelineKey}:${job.stage}`);
      return st && !st.isTerminal && isStale(job.stageEnteredAt, st.staleAfterDays, now);
    })
    .map(({ job, address }) => ({
      jobNumber: job.jobNumber,
      stage: stageMap.get(`${job.pipelineKey}:${job.stage}`)?.name ?? job.stage,
      days: daysInStage(job.stageEnteredAt, now),
      address,
    }))
    .sort((a, b) => b.days - a.days);

  // --- lab results in, not yet reviewed ---
  const lab = await conn
    .select({ jobNumber: s.jobs.jobNumber, stage: s.jobs.stage, n: sql<number>`count(*)::int` })
    .from(s.samples)
    .innerJoin(s.jobs, eq(s.jobs.id, s.samples.jobId))
    .where(and(eq(s.samples.status, "RESULTS_IN"), isNull(s.samples.archivedAt), isNull(s.jobs.archivedAt)))
    .groupBy(s.jobs.jobNumber, s.jobs.stage);

  // --- unpaid invoices ---
  const ar = await arAging(conn, now);

  // --- going-cold leads: last inbound > 24h ago (within 14 days), nothing sent back since ---
  const cold = await conn.execute<{ id: string; first_name: string | null; last_name: string | null; phones: string[]; emails: string[]; last_in: Date; channel: string }>(sql`
    with last_in as (
      select distinct on (a.contact_id) a.contact_id, a.occurred_at, a.type
      from ${s.activities} a
      where a.direction = 'INBOUND' and a.type in ('SMS','CALL','EMAIL_IN') and a.contact_id is not null
        and a.occurred_at > ${new Date(now.getTime() - 14 * 86_400_000).toISOString()}
      order by a.contact_id, a.occurred_at desc
    )
    select c.id, c.first_name, c.last_name, c.phones, c.emails, l.occurred_at as last_in, l.type as channel
    from last_in l
    join ${s.contacts} c on c.id = l.contact_id and c.archived_at is null and not c.do_not_contact
    where l.occurred_at < ${new Date(now.getTime() - 24 * 3600_000).toISOString()}
      and not exists (
        select 1 from ${s.activities} o where o.contact_id = l.contact_id and o.direction = 'OUTBOUND' and o.occurred_at > l.occurred_at
      )
      and not exists (
        select 1 from ${s.jobs} j where j.client_contact_id = c.id and j.archived_at is null
          and j.stage not in ('LEAD','QUALIFIED','LOST')
      )
    order by l.occurred_at asc
    limit 25`);

  const [{ overdue }] = await conn
    .select({ overdue: sql<number>`count(*)::int` })
    .from(s.tasks)
    .where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), lt(s.tasks.dueAt, now)));

  return {
    date: nyDate(now),
    staleJobs,
    labWaiting: lab.map((l) => ({ jobNumber: l.jobNumber, samples: l.n, stage: l.stage })),
    unpaid: {
      total: ar.total,
      byBucket: ar.totalsByBucket,
      worst: ar.items
        .filter((i) => i.bucket !== "current")
        .slice(0, 8)
        .map((i) => ({ invoiceNumber: i.invoiceNumber, client: i.client, outstanding: i.outstanding, bucket: i.bucket })),
    },
    goingCold: cold.rows.map((r) => ({
      name: personName({ firstName: r.first_name, lastName: r.last_name }),
      phoneOrEmail: r.phones?.[0] ?? r.emails?.[0] ?? null,
      lastInbound: new Date(r.last_in),
      channel: r.channel,
    })),
    expiring: await expiringItems(conn, now, 60),
    cyclesDue: await upcomingCycles(conn, nyDate(now), addDays(nyDate(now), 60)),
    bidsDue: (
      await conn
        .select({ title: s.bids.title, agency: s.bids.agency, dueAt: s.bids.dueAt, status: s.bids.status, goNoGo: s.bids.goNoGo })
        .from(s.bids)
        .where(and(isNull(s.bids.archivedAt), inArray(s.bids.status, ["WATCHING", "GO_NO_GO", "DRAFTING"]), sql`${s.bids.dueAt} between ${now.toISOString()} and ${new Date(now.getTime() + 7 * 86_400_000).toISOString()}`))
        .orderBy(s.bids.dueAt)
    ).map((b) => ({ title: b.title, agency: b.agency, dueAt: b.dueAt!, status: b.status, recommendation: b.goNoGo?.recommendation ?? null })),
    overdueTasks: overdue,
  };
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function renderDigestText(d: Digest, appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? ""): { subject: string; text: string } {
  const lines: string[] = [`ESS CRM — daily digest for ${fmtDate(`${d.date}`)}`, ""];
  const section = (title: string, items: string[], empty: string) => {
    lines.push(`${title}`, ...(items.length ? items.map((i) => `  • ${i}`) : [`  ${empty}`]), "");
  };
  section(`STALE JOBS (${d.staleJobs.length})`, d.staleJobs.slice(0, 15).map((j) => `${j.jobNumber} — ${j.stage}, ${j.days}d${j.address ? ` — ${j.address}` : ""}`), "None. Nothing is stuck.");
  section(`LAB RESULTS WAITING FOR REVIEW (${d.labWaiting.length} jobs)`, d.labWaiting.map((l) => `${l.jobNumber} — ${l.samples} sample(s), job in ${l.stage}`), "None.");
  const b = d.unpaid.byBucket;
  section(
    `UNPAID INVOICES — ${usd(d.unpaid.total)} outstanding`,
    [
      `Current ${usd(b.current)} · 1–30 ${usd(b["1-30"])} · 31–60 ${usd(b["31-60"])} · 61–90 ${usd(b["61-90"])} · 90+ ${usd(b["90+"])}`,
      ...d.unpaid.worst.map((w) => `#${w.invoiceNumber ?? "?"} ${w.client ?? ""} — ${usd(w.outstanding)} (${w.bucket} days)`),
    ],
    "",
  );
  section(
    `GOING-COLD LEADS (${d.goingCold.length})`,
    d.goingCold.map((g) => `${g.name}${g.phoneOrEmail ? ` (${g.phoneOrEmail})` : ""} — last ${g.channel === "EMAIL_IN" ? "email" : g.channel.toLowerCase()} ${fmtDate(g.lastInbound, true)}, no reply yet`),
    "None — every inbound lead has had a reply.",
  );
  section(
    `LICENSES & INSURANCE EXPIRING (${d.expiring.length})`,
    d.expiring.map((e) => `${e.name} — ${e.daysLeft < 0 ? `EXPIRED ${e.expiresOn}` : `${e.expiresOn} (${e.daysLeft} days)`}`),
    "Nothing expires in the next 60 days.",
  );
  section(
    `COMPLIANCE CYCLES DUE IN 60 DAYS (${d.cyclesDue.length})`,
    d.cyclesDue.slice(0, 20).map((c) => `${c.due} — ${c.serviceCode} — ${c.client ?? "no client"}${c.address ? `, ${c.address}` : ""} (last job ${c.jobNumber})`),
    "None.",
  );
  section(
    `BIDS DUE WITHIN 7 DAYS (${d.bidsDue.length})`,
    d.bidsDue.map((b) => `${fmtDate(b.dueAt, true)} — ${b.title}${b.agency ? ` (${b.agency})` : ""} · ${b.status.replace("_", "-").toLowerCase()}${b.recommendation ? ` · AI: ${b.recommendation.replace("_", "-")}` : ""}`),
    "None.",
  );
  lines.push(`OVERDUE TASKS: ${d.overdueTasks}`, "");
  if (appUrl) lines.push(`Open the CRM: ${appUrl}`);
  return { subject: `ESS digest ${d.date}: ${d.staleJobs.length} stale · ${d.labWaiting.length} lab · ${usd(d.unpaid.total)} unpaid · ${d.goingCold.length} cold leads`, text: lines.join("\n") };
}

export function renderDigestSms(d: Digest): string {
  const over90 = d.unpaid.byBucket["90+"];
  return [
    `ESS ${d.date.slice(5)}:`,
    `${d.staleJobs.length} stale jobs`,
    `${d.labWaiting.length} lab results to review`,
    `${usd(d.unpaid.total)} unpaid${over90 ? ` (${usd(over90)} 90+ days)` : ""}`,
    `${d.goingCold.length} cold leads`,
    ...(d.expiring.length ? [`${d.expiring.length} licenses/COIs expiring`] : []),
    ...(d.bidsDue.length ? [`${d.bidsDue.length} bids due this week`] : []),
    `${d.overdueTasks} overdue tasks`,
  ].join(" · ").replace(":·", ":");
}

/** True on weekdays at/after the configured digest time (New York). */
export function isDigestDue(now: Date, digestTime: string): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  return `${parts.hour}:${parts.minute}` >= digestTime.slice(0, 5);
}

/** Sends today's digest once (digest_runs is the idempotency key). Returns what happened. */
export async function sendDigestIfDue(
  db: Db,
  deps: { mail: MailSender | null; quo: QuoClient | null },
  now = new Date(),
): Promise<"not-due" | "disabled" | "already-sent" | "sent" | "no-recipients"> {
  const [cfg] = await db.select().from(s.settings);
  if (!cfg?.digestEnabled) return "disabled";
  if (!isDigestDue(now, cfg.digestTime)) return "not-due";
  const date = nyDate(now);
  const claimed = await db.insert(s.digestRuns).values({ runDate: date, recipients: cfg.digestRecipients }).onConflictDoNothing().returning();
  if (!claimed.length) return "already-sent";

  const digest = await buildDigest(db, now);
  const { subject, text } = renderDigestText(digest);
  const errors: string[] = [];
  const recipients = cfg.digestRecipients;
  if (deps.mail) {
    for (const to of recipients) {
      await deps.mail.send({ from: cfg.defaultFromEmail, to, subject, text }).catch((e) => errors.push(`email ${to}: ${(e as Error).message}`));
    }
  } else if (recipients.length) errors.push("email not configured");
  if (cfg.digestSmsEnabled && cfg.healthAlertPhone && cfg.healthAlertLineId && deps.quo) {
    const [line] = await db.select().from(s.phoneLines).where(eq(s.phoneLines.id, cfg.healthAlertLineId));
    if (line) await deps.quo.sendSms({ from: line.quoPhoneNumberId, to: cfg.healthAlertPhone, content: renderDigestSms(digest) }).catch((e) => errors.push(`sms: ${(e as Error).message}`));
  }
  await db
    .update(s.digestRuns)
    .set({
      summary: { stale: digest.staleJobs.length, lab: digest.labWaiting.length, unpaid: digest.unpaid.total, cold: digest.goingCold.length, overdueTasks: digest.overdueTasks },
      error: errors.join("; ") || null,
    })
    .where(eq(s.digestRuns.runDate, date));
  return recipients.length || cfg.healthAlertPhone ? "sent" : "no-recipients";
}

