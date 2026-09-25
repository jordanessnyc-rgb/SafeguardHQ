import { asc, isNull } from "drizzle-orm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { BRAND_LABELS, titleCase, usd } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { siteOrigin } from "@/lib/site";
import { campaignResults } from "@/lib/marketing/results";
import { headers } from "next/headers";
import { saveCampaign, saveCampaignCost } from "./actions";

export const metadata = { title: "Campaigns" };

type Campaign = typeof s.campaigns.$inferSelect;

function CampaignFields({ c, lines }: { c?: Campaign; lines: { number: string; label: string }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Field label="Name"><Input name="name" defaultValue={c?.name ?? ""} required /></Field>
      <Field label="Channel">
        <NativeSelect name="channel" defaultValue={c?.channel ?? "DIRECT_MAIL"}>
          {s.campaignChannelEnum.enumValues.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Brand">
        <NativeSelect name="brand" defaultValue={c?.brand ?? "ESS"}>
          {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <Field label="QR code name" hint="Printed as …/q/<name>"><Input name="qrSlug" defaultValue={c?.tracking?.qrSlug ?? ""} placeholder="ll152-mailer-oct" /></Field>
      <Field label="Tracking phone line" hint="New callers on this line count as leads.">
        <NativeSelect name="quoNumber" defaultValue={c?.tracking?.quoNumber ?? ""}>
          <option value="">—</option>
          {lines.map((l) => <option key={l.number} value={l.number}>{l.label} · {formatPhone(l.number)}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Landing page"><Input name="landingUrl" defaultValue={c?.tracking?.landingUrl ?? ""} placeholder="https://ess-nyc.com/ll152" /></Field>
      <Field label="Pieces sent"><Input name="sentCount" inputMode="numeric" defaultValue={c?.sentCount ?? ""} /></Field>
      <Field label="Notes" className="sm:col-span-2"><Input name="notes" defaultValue={c?.notes ?? ""} /></Field>
    </div>
  );
}

export default async function CampaignsPage() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const origin = siteOrigin(await headers());
  const d = await user.db(async (tx) => ({
    campaigns: await tx.select().from(s.campaigns).where(isNull(s.campaigns.archivedAt)).orderBy(asc(s.campaigns.name)),
    lines: await tx.select({ number: s.phoneLines.number, label: s.phoneLines.label }).from(s.phoneLines),
    results: await campaignResults(tx),
  }));

  return (
    <>
      <PageHeader title="Campaigns" description="Mailers, emails and landing pages → scans, leads, jobs. Leads are credited to the first campaign that brought them in." />
      <div className="space-y-4">
        {d.campaigns.map((c) => {
          const r = d.results.get(c.id);
          const perLead = isOwner && r?.cost != null && r.leads ? r.cost / r.leads : null;
          return (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle>{c.name}</CardTitle>
                <CardDescription>
                  {r?.scans ?? 0} QR scans · {r?.leads ?? 0} leads · {r?.jobs ?? 0} jobs · {r?.won ?? 0} won
                  {isOwner && (
                    <>
                      {" "}· revenue {usd(r?.revenue ?? 0, false)} · cost {r?.cost != null ? usd(r.cost, false) : "—"}
                      {perLead != null && ` · ${usd(perLead)} per lead`}
                      {r?.cost && r.revenue != null ? ` · ${(r.revenue / r.cost).toFixed(1)}× return` : ""}
                    </>
                  )}
                  {c.tracking?.qrSlug && <span className="block font-mono text-xs">QR: {origin}/q/{c.tracking.qrSlug}</span>}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ActionForm action={saveCampaign.bind(null, c.id)} className="space-y-2">
                  <CampaignFields c={c} lines={d.lines} />
                  <SubmitButton size="xs" variant="secondary">Save</SubmitButton>
                </ActionForm>
                {isOwner && (
                  <ActionForm action={saveCampaignCost.bind(null, c.id)} className="flex items-end gap-2 border-t pt-3">
                    <Field label="Total cost (owner only)"><Input name="cost" inputMode="decimal" defaultValue={r?.cost ?? ""} className="w-32" /></Field>
                    <SubmitButton size="xs" variant="ghost">Save cost</SubmitButton>
                  </ActionForm>
                )}
              </CardContent>
            </Card>
          );
        })}
        <Card>
          <CardHeader><CardTitle>New campaign</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={saveCampaign.bind(null, null)} className="space-y-2">
              <CampaignFields lines={d.lines} />
              <SubmitButton size="sm">Add campaign</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Website lead form</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>Point the ess-nyc.com contact form at <code className="text-foreground">{origin}/api/leads</code> (POST, JSON or a normal form). Fields: name, email, phone, address, unit, service, message, campaign (the page&apos;s utm_campaign), and an empty hidden &quot;website&quot; field. A normal form can add redirect=&lt;thank-you page&gt;.</p>
            <p>Each submission creates the contact, property and a Lead job, a task, and a draft acknowledgment text in the Outbox.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
