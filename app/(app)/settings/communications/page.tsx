import Link from "next/link";
import { asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { BRAND_LABELS, fmtDate } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { deleteLine, importQuoNumbers, saveCommsSettings, saveLine, saveTemplate } from "./actions";

export const metadata = { title: "Communications settings" };

export default async function CommsSettingsPage() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const d = await user.db(async (tx) => {
    const monthStart = new Date(new Date().toISOString().slice(0, 8) + "01T00:00:00Z");
    return {
      cfg: (await tx.select().from(s.settings))[0],
      lines: await tx.select().from(s.phoneLines).orderBy(asc(s.phoneLines.label)),
      templates: await tx.select().from(s.messageTemplates).orderBy(asc(s.messageTemplates.name)),
      mail: await tx.select().from(s.mailSyncState),
      pendingTriage: (await tx.select({ n: count() }).from(s.activities).where(eq(s.activities.triageStatus, "PENDING")))[0].n,
      // Owner-only tables: RLS returns nothing for a VA.
      lastQuo: (await tx.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.provider, "QUO")).orderBy(desc(s.webhookDeliveries.receivedAt)).limit(1))[0],
      quoErrors: (await tx.select({ n: count() }).from(s.webhookDeliveries).where(sql`${s.webhookDeliveries.error} is not null and ${s.webhookDeliveries.processedAt} is null`))[0].n,
      aiSpend: (await tx.select({ usd: sql<string>`coalesce(sum(${s.aiCalls.costUsd}), 0)`, calls: count(), blocked: sql<number>`count(*) filter (where ${s.aiCalls.blocked} is not null)::int` }).from(s.aiCalls).where(gte(s.aiCalls.at, monthStart)))[0],
    };
  });
  const env = {
    quo: Boolean(process.env.QUO_API_KEY),
    quoWebhook: Boolean(process.env.QUO_WEBHOOK_SECRET),
    titan: Boolean(process.env.TITAN_USER && process.env.TITAN_PASSWORD),
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
  };

  return (
    <>
      <PageHeader title="Communications" description={<Link href="/settings" className="hover:underline">← Settings</Link>} />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Integration health</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="font-medium">Quo</div>
            <div className="text-xs text-muted-foreground">API key {env.quo ? "✓" : "✗ missing"} · webhook secret {env.quoWebhook ? "✓" : "✗ missing"}</div>
            {isOwner && <div className="text-xs">Last event: {d.lastQuo ? `${d.lastQuo.eventType} · ${fmtDate(d.lastQuo.receivedAt, true)}` : "none yet"}</div>}
            {isOwner && d.quoErrors > 0 && <div className="text-xs text-destructive">{d.quoErrors} failed deliveries (Quo will retry)</div>}
          </div>
          <div>
            <div className="font-medium">Titan email</div>
            <div className="text-xs text-muted-foreground">Credentials {env.titan ? "✓ (worker)" : "✗ not set on this host"}</div>
            {d.mail.length === 0 && <div className="text-xs">Worker hasn&apos;t connected yet.</div>}
            {d.mail.map((m) => (
              <div key={m.mailbox + m.folder} className="text-xs">
                {m.mailbox}: last OK {fmtDate(m.lastOkAt, true)}
                {m.lastError && <span className="block text-destructive">{m.lastError}</span>}
              </div>
            ))}
          </div>
          <div>
            <div className="font-medium">AI triage</div>
            <div className="text-xs text-muted-foreground">API key {env.ai ? "✓" : "✗ missing (messages go to review)"}</div>
            <div className="text-xs">{d.pendingTriage} waiting</div>
          </div>
          {isOwner && (
            <div>
              <div className="font-medium">AI spend this month</div>
              <div className="text-xs">
                ${Number(d.aiSpend.usd).toFixed(2)} · {d.aiSpend.calls} calls · {d.aiSpend.blocked} blocked
                {d.cfg.aiMonthlyCostCapUsd && ` · cap $${d.cfg.aiMonthlyCostCapUsd}`}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quo phone lines</CardTitle>
            <CardDescription>Each Quo number → a line key (shown on the timeline) and brand. The line key AIRNYC marks a line whose texts/calls are stored encrypted.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {d.lines.map((l) => (
              <div key={l.id} className="rounded-lg border p-2">
              <ActionForm action={saveLine.bind(null, l.id)} className="grid gap-2 sm:grid-cols-3">
                <fieldset disabled={!isOwner} className="contents">
                  <Input name="label" defaultValue={l.label} aria-label="Label" />
                  <Input name="lineKey" defaultValue={l.lineKey} aria-label="Line key" />
                  <NativeSelect name="brand" defaultValue={l.brand} aria-label="Brand">
                    {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </NativeSelect>
                  <Input name="number" defaultValue={formatPhone(l.number)} aria-label="Number" />
                  <Input name="quoPhoneNumberId" defaultValue={l.quoPhoneNumberId} aria-label="Quo id" />
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="missedCallTextback" defaultChecked={l.missedCallTextback} className="size-4 accent-primary" /> Missed-call text-back
                  </label>
                  {isOwner && <SubmitButton size="xs" variant="secondary">Save</SubmitButton>}
                </fieldset>
              </ActionForm>
              {isOwner && (
                <form action={deleteLine.bind(null, l.id)} className="mt-1 text-right">
                  <Button size="xs" variant="ghost" type="submit">Remove line</Button>
                </form>
              )}
              </div>
            ))}
            {isOwner && (
              <>
                <ActionForm action={saveLine.bind(null, null)} className="grid gap-2 rounded-lg border border-dashed p-2 sm:grid-cols-3">
                  <Input name="label" placeholder="Label (ESS main)" required />
                  <Input name="lineKey" placeholder="ESS_MAIN" required />
                  <NativeSelect name="brand" defaultValue="ESS" aria-label="Brand">
                    {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </NativeSelect>
                  <Input name="number" placeholder="929-305-1232" required />
                  <Input name="quoPhoneNumberId" placeholder="PN…" required />
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="missedCallTextback" className="size-4 accent-primary" /> Missed-call text-back
                  </label>
                  <SubmitButton size="xs">Add line</SubmitButton>
                </ActionForm>
                <ActionForm action={importQuoNumbers} className="flex flex-col items-start gap-1">
                  <SubmitButton size="sm" variant="outline">Import numbers from Quo</SubmitButton>
                </ActionForm>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Messaging &amp; alerts</CardTitle>
            <CardDescription>
              Auto-send for texts and emails is on the main <Link href="/settings" className="underline">Settings</Link> page. While it&apos;s off, missed-call text-backs wait in the Outbox.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveCommsSettings} className="space-y-3">
              <fieldset disabled={!isOwner} className="space-y-3">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="quoSummariesEnabled" defaultChecked={d.cfg.quoSummariesEnabled} className="mt-0.5 size-4 accent-primary" />
                  <span>Quo call summaries &amp; transcripts <span className="block text-xs text-muted-foreground">Business/Scale plan only. When on, summary next steps become tasks.</span></span>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Alert texts go to" hint="Jordan's cell — integration outages only.">
                    <Input name="healthAlertPhone" defaultValue={d.cfg.healthAlertPhone ? formatPhone(d.cfg.healthAlertPhone) : ""} />
                  </Field>
                  <Field label="…sent from line">
                    <NativeSelect name="healthAlertLineId" defaultValue={d.cfg.healthAlertLineId ?? ""}>
                      <option value="">—</option>
                      {d.lines.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                    </NativeSelect>
                  </Field>
                  <Field label="Default From for emails">
                    <Input name="defaultFromEmail" defaultValue={d.cfg.defaultFromEmail} />
                  </Field>
                  <Field label="AI triage confidence threshold" hint="Below this → review queue.">
                    <Input name="triageConfidenceThreshold" inputMode="decimal" defaultValue={d.cfg.triageConfidenceThreshold} />
                  </Field>
                </div>
                <Field label="How Jordan writes (for AI reply drafts)" hint="Tone, greeting and sign-off, phrases you use or avoid. AI drafts always wait in the Outbox for approval.">
                  <Textarea name="aiVoiceNotes" rows={3} defaultValue={d.cfg.aiVoiceNotes ?? ""} placeholder="e.g. Friendly but brief. First names. Sign emails 'Best, Jordan'. Never promise same-day results." />
                </Field>
                <Field label="AIRnyc sender domains" hint="Email from these domains is stored encrypted even without a case ID. Comma-separated.">
                  <Input name="airnycSenderDomains" defaultValue={d.cfg.airnycSenderDomains.join(", ")} placeholder="airnyc.org" />
                </Field>
                {isOwner && <SubmitButton size="sm">Save</SubmitButton>}
              </fieldset>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Message templates</CardTitle>
          <CardDescription>
            Tokens: {"{{first_name}} {{job_number}} {{address}} {{scheduled_date}} {{scheduled_time}} {{brand_name}} {{brand_phone}} {{review_url}}"}. The starting wording is a draft — review before use.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {d.templates.map((t) => (
            <ActionForm key={t.id} action={saveTemplate.bind(null, t.id)} className="space-y-2 rounded-lg border p-3">
              <fieldset disabled={!isOwner} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Input name="name" defaultValue={t.name} aria-label="Name" />
                  <Badge variant="outline">{t.channel}</Badge>
                </div>
                <code className="text-[10px] text-muted-foreground">{t.key}</code>
                {t.channel === "EMAIL" && <Input name="subject" defaultValue={t.subject ?? ""} placeholder="Subject" />}
                <Textarea name="body" defaultValue={t.body} rows={3} aria-label="Body" />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="active" defaultChecked={t.active} className="size-4 accent-primary" /> Active
                </label>
                {isOwner && <SubmitButton size="xs" variant="secondary">Save</SubmitButton>}
              </fieldset>
            </ActionForm>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
