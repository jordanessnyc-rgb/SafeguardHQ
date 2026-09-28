import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { sql } from "drizzle-orm";
import { label, SERVICE_LABELS, usd } from "@/lib/labels";
import { savePricingRule } from "./actions";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  const user = await requireOwner(); // VAs are redirected; RLS also hides pricing_rules from them
  const { rules, history } = await user.db(async (tx) => ({
    rules: await tx.select().from(s.pricingRules),
    // What each service has actually been billed at (imported FreshBooks history + CRM jobs), to set prices from.
    history: (await tx.execute<{ service_code: string; jobs: number; p25: string; median: string; p75: string; line_price: string | null }>(sql`
      select j.service_code, count(*)::int as jobs,
        percentile_cont(0.25) within group (order by f.quoted_amount) as p25,
        percentile_cont(0.5) within group (order by f.quoted_amount) as median,
        percentile_cont(0.75) within group (order by f.quoted_amount) as p75,
        (select mode() within group (order by (l->>'unitPrice')::numeric)
           from ${s.jobFinancials} f2 join ${s.jobs} j2 on j2.id = f2.job_id, jsonb_array_elements(f2.line_items) l
          where j2.service_code = j.service_code and (l->>'unitPrice')::numeric > 0) as line_price
      from ${s.jobs} j join ${s.jobFinancials} f on f.job_id = j.id
      where j.archived_at is null and j.stage <> 'LOST' and f.quoted_amount > 0
      group by j.service_code`)).rows,
  }));
  const past = new Map(history.map((h) => [h.service_code, h]));
  const byCode = new Map(rules.map((r) => [r.serviceCode, r]));

  return (
    <>
      <PageHeader
        title="Pricing"
        description={
          <>
            Owner only. The quote builder prices each job as base + area over the included sq ft + samples over the included count, raised to the minimum.
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {s.serviceCodeEnum.enumValues.map((code) => {
          const r = byCode.get(code);
          return (
            <Card key={code}>
              <CardHeader>
                <CardTitle>{label(SERVICE_LABELS, code)}</CardTitle>
                {!r && <CardDescription>No price set — quotes for this service use only lines entered by hand.</CardDescription>}
                {past.get(code) && (
                  <CardDescription>
                    Your history: {past.get(code)!.jobs} jobs, typically {usd(past.get(code)!.median)} (middle half {usd(past.get(code)!.p25)}–{usd(past.get(code)!.p75)})
                    {past.get(code)!.line_price ? `; most common line price ${usd(past.get(code)!.line_price)}` : ""}.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <ActionForm action={savePricingRule} className="grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="serviceCode" value={code} />
                  <Field label="Base price $"><Input name="baseAmount" inputMode="decimal" defaultValue={r?.baseAmount ?? ""} placeholder={past.get(code) ? String(Math.round(Number(past.get(code)!.median))) : undefined} required /></Field>
                  <Field label="Sq ft included"><Input name="includedSqft" inputMode="numeric" defaultValue={r?.includedSqft ?? 0} /></Field>
                  <Field label="$ per extra sq ft"><Input name="perSqft" inputMode="decimal" defaultValue={r?.perSqft ?? ""} /></Field>
                  <Field label="Minimum $"><Input name="minimumAmount" inputMode="decimal" defaultValue={r?.minimumAmount ?? ""} /></Field>
                  <Field label="Samples included"><Input name="includedSamples" inputMode="numeric" defaultValue={r?.includedSamples ?? 0} /></Field>
                  <Field label="$ per extra sample"><Input name="perSample" inputMode="decimal" defaultValue={r?.perSample ?? ""} /></Field>
                  <Field label="Default scope (proposal)" className="sm:col-span-3">
                    <Textarea name="defaultScope" rows={2} defaultValue={r?.defaultScope ?? ""} />
                  </Field>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="active" defaultChecked={r?.active ?? true} className="size-4 accent-primary" /> Active
                  </label>
                  <div className="sm:col-span-2 text-right"><SubmitButton size="xs">{r ? "Save" : "Set price"}</SubmitButton></div>
                </ActionForm>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
