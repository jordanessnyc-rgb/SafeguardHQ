import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { savePricingRule } from "./actions";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  const user = await requireOwner(); // VAs are redirected; RLS also hides pricing_rules from them
  const rules = await user.db((tx) => tx.select().from(s.pricingRules));
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
              </CardHeader>
              <CardContent>
                <ActionForm action={savePricingRule} className="grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="serviceCode" value={code} />
                  <Field label="Base price $"><Input name="baseAmount" inputMode="decimal" defaultValue={r?.baseAmount ?? ""} required /></Field>
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
