"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { computeQuote, type PricingRule } from "@/lib/money/quote";
import { cn } from "@/lib/utils";
import { saveQuote } from "../actions";

type Line = { key: number; description: string; quantity: string; unitPrice: string };
export type PriceListItem = { serviceCode: string; label: string; baseAmount: string; defaultScope: string | null };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const num = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const opt = (v: string) => (v.trim() === "" ? null : num(v));
let seq = 0;
const line = (description = "", quantity: number | string = 1, unitPrice: number | string = ""): Line => ({ key: ++seq, description, quantity: String(quantity), unitPrice: unitPrice === "" ? "" : String(unitPrice) });

/**
 * The job's quote as an editable table (owner only). "Price it" fills the table from Jordan's pricing
 * rule for the service, using the area and sample count; any line can then be edited, removed or added,
 * including other services from the price list. Totals and margin update as you type; Save stores it.
 */
export function QuoteEditor({
  jobId,
  serviceName,
  rule,
  priceList,
  initial,
  holdDefault,
}: {
  jobId: string;
  serviceName: string;
  rule: (PricingRule & { defaultScope: string | null }) | null;
  priceList: PriceListItem[];
  initial: {
    lines: { description: string; quantity: number; unitPrice: number }[];
    quotedAmount: string | null;
    subCost: string | null;
    labCost: string | null;
    otherCost: string | null;
    holdReportUntilPaid: boolean | null;
    sqft: number | null;
    samples: number | null;
    scope: string | null;
    validDays: number | null;
  };
  holdDefault: boolean;
}) {
  const [lines, setLines] = useState<Line[]>(() => initial.lines.map((l) => line(l.description, l.quantity, l.unitPrice)));
  const [flat, setFlat] = useState(initial.lines.length ? "" : (initial.quotedAmount ?? ""));
  const [sqft, setSqft] = useState(initial.sqft?.toString() ?? "");
  const [samples, setSamples] = useState(initial.samples?.toString() ?? "");
  const [scope, setScope] = useState(initial.scope ?? rule?.defaultScope ?? "");
  const [validDays, setValidDays] = useState(String(initial.validDays ?? 30));
  const [costs, setCosts] = useState({ subCost: initial.subCost ?? "", labCost: initial.labCost ?? "", otherCost: initial.otherCost ?? "" });
  const [hold, setHold] = useState(initial.holdReportUntilPaid == null ? "" : String(initial.holdReportUntilPaid));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const touch = () => setDirty(true);

  const totals = useMemo(() => {
    const priced = lines.map((l) => num(l.quantity) * num(l.unitPrice));
    const revenue = lines.length ? priced.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : (opt(flat) ?? 0);
    const cost = ["subCost", "labCost", "otherCost"].reduce((a, k) => a + (opt(costs[k as keyof typeof costs]) ?? 0), 0);
    const margin = revenue - cost;
    return { priced, revenue, cost, margin, pct: revenue ? Math.round((margin / revenue) * 1000) / 10 : null };
  }, [lines, flat, costs]);

  const priceIt = () => {
    const q = computeQuote(serviceName, rule, { sqft: sqft ? Number(sqft) : null, samples: samples ? Number(samples) : null });
    // Keep any hand-added lines that aren't part of the rule's own lines.
    const ruleLines = q.lines.map((l) => line(l.description, l.quantity, l.unitPrice));
    const own = new Set(q.lines.map((l) => l.description));
    setLines((cur) => [...ruleLines, ...cur.filter((l) => l.description && !own.has(l.description) && !/^Additional (area|samples)|^Laboratory samples|^Minimum service charge/.test(l.description))]);
    q.notes.forEach((n) => toast.info(n));
    touch();
  };

  const update = (key: number, patch: Partial<Line>) => (setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l))), touch());

  const save = () => {
    setError(undefined);
    const bad = lines.find((l) => !l.description.trim() || !(num(l.quantity) > 0) || !(num(l.unitPrice) >= 0));
    if (bad) return setError("Each line needs a description, a quantity above 0 and a price.");
    start(async () => {
      const r = await saveQuote(jobId, {
        lines: lines.map((l) => ({ description: l.description.trim(), quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
        quotedAmount: lines.length ? null : opt(flat),
        subCost: opt(costs.subCost),
        labCost: opt(costs.labCost),
        otherCost: opt(costs.otherCost),
        holdReportUntilPaid: hold === "" ? null : hold === "true",
        inputs: { sqft: sqft ? Math.round(Number(sqft)) : null, samples: samples ? Math.round(Number(samples)) : null, scope: scope.trim() || null, validDays: validDays ? Math.round(Number(validDays)) : null },
      });
      if (r.error) return setError(r.error);
      toast.success(r.message ?? "Saved");
      setDirty(false);
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="q-sqft" className="text-xs">Area (sq ft)</Label>
            <Input id="q-sqft" inputMode="numeric" value={sqft} onChange={(e) => (setSqft(e.target.value), touch())} className="h-8 w-28" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="q-samples" className="text-xs">Samples</Label>
            <Input id="q-samples" inputMode="numeric" value={samples} onChange={(e) => (setSamples(e.target.value), touch())} className="h-8 w-20" />
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={priceIt} disabled={!rule}>
            <Sparkles /> Price it from your price list
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {rule
            ? `${serviceName}: base ${usd(Number(rule.baseAmount))}${rule.perSqft ? ` · ${usd(Number(rule.perSqft))}/sq ft over ${rule.includedSqft.toLocaleString("en-US")}` : ""}${rule.perSample ? ` · ${usd(Number(rule.perSample))}/sample over ${rule.includedSamples}` : ""}${rule.minimumAmount ? ` · minimum ${usd(Number(rule.minimumAmount))}` : ""}. Pricing it replaces the rule's lines and keeps lines you added.`
            : `No price set for ${serviceName} yet (Settings → Pricing). You can still add lines by hand.`}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-medium">Description</th>
              <th className="w-20 py-1.5 pr-2 text-right font-medium">Qty</th>
              <th className="w-28 py-1.5 pr-2 text-right font-medium">Unit price</th>
              <th className="w-28 py-1.5 pr-2 text-right font-medium">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-b last:border-0">
                <td className="py-1 pr-2">
                  <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Line ${i + 1} description`} className="h-8" placeholder="What the client is paying for" />
                </td>
                <td className="py-1 pr-2">
                  <Input value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="h-8 text-right tabular-nums" />
                </td>
                <td className="py-1 pr-2">
                  <Input value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} inputMode="decimal" aria-label={`Line ${i + 1} unit price`} className="h-8 text-right tabular-nums" placeholder="0.00" />
                </td>
                <td className={cn("py-1 pr-2 text-right tabular-nums", !Number.isFinite(totals.priced[i]) && "text-destructive")}>{Number.isFinite(totals.priced[i]) ? usd(totals.priced[i]) : "—"}</td>
                <td className="py-1 text-right">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => (setLines((cur) => cur.filter((x) => x.key !== l.key)), touch())}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length === 0 && (
          <div className="flex flex-wrap items-center gap-2 py-2 text-sm text-muted-foreground">
            No lines yet: price it above, add a line, or enter one total
            <Input value={flat} onChange={(e) => (setFlat(e.target.value), touch())} inputMode="decimal" placeholder="Total $" aria-label="Quoted total" className="h-8 w-28" />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => (setLines((cur) => [...cur, line()]), touch())}>
            <Plus /> Add line
          </Button>
          {priceList.length > 0 && (
            <NativeSelect
              aria-label="Add a service from your price list"
              className="h-8 w-auto"
              value=""
              onChange={(e) => {
                const item = priceList.find((p) => p.serviceCode === e.target.value);
                if (!item) return;
                setLines((cur) => [...cur, line(item.label, 1, Number(item.baseAmount))]);
                touch();
              }}
            >
              <option value="">+ Add from price list…</option>
              {priceList.map((p) => <option key={p.serviceCode} value={p.serviceCode}>{p.label} ({usd(Number(p.baseAmount))})</option>)}
            </NativeSelect>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="q-scope" className="text-xs">Scope (on the proposal)</Label>
            <Textarea id="q-scope" rows={3} value={scope} onChange={(e) => (setScope(e.target.value), touch())} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {(["subCost", "labCost", "otherCost"] as const).map((k) => (
              <div key={k} className="grid gap-1">
                <Label htmlFor={`q-${k}`} className="text-xs">{k === "subCost" ? "Sub cost $" : k === "labCost" ? "Lab cost $" : "Other cost $"}</Label>
                <Input id={`q-${k}`} inputMode="decimal" value={costs[k]} onChange={(e) => (setCosts({ ...costs, [k]: e.target.value }), touch())} className="h-8" />
              </div>
            ))}
            <div className="grid gap-1">
              <Label htmlFor="q-valid" className="text-xs">Quote valid (days)</Label>
              <Input id="q-valid" inputMode="numeric" value={validDays} onChange={(e) => (setValidDays(e.target.value), touch())} className="h-8" />
            </div>
          </div>
          <div className="grid max-w-xs gap-1">
            <Label htmlFor="q-hold" className="text-xs">Hold report until paid</Label>
            <NativeSelect id="q-hold" value={hold} onChange={(e) => (setHold(e.target.value), touch())} className="h-8">
              <option value="">Client / Settings default ({holdDefault ? "hold" : "don't hold"})</option>
              <option value="true">Hold until paid</option>
              <option value="false">Don&apos;t hold</option>
            </NativeSelect>
          </div>
        </div>
        <dl className="h-fit space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">Quote total</dt><dd className="text-base font-semibold tabular-nums">{usd(totals.revenue)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Costs</dt><dd className="tabular-nums">{usd(totals.cost)}</dd></div>
          <div className="flex justify-between border-t pt-1.5">
            <dt className="text-muted-foreground">Gross margin</dt>
            <dd className={cn("font-semibold tabular-nums", totals.margin < 0 && "text-destructive")}>
              {usd(totals.margin)}
              {totals.pct !== null && <span className="ml-1 text-xs font-normal text-muted-foreground">({totals.pct}%)</span>}
            </dd>
          </div>
        </dl>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save quote"}</Button>
        {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">Unsaved changes</span>}
      </div>
    </div>
  );
}
