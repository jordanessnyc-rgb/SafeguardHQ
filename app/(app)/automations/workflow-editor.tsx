"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/actions";
import {
  CONDITION_LABELS,
  MESSAGE_TOKENS,
  OUTREACH_STEPS,
  STEP_LABELS,
  TRIGGER_LABELS,
  type Condition,
  type Step,
  type Trigger,
} from "@/lib/automation/definition";
import type { Tag } from "@/lib/tag-style";

export type EditorOptions = {
  pipelines: { key: string; name: string }[];
  stages: { pipelineKey: string; pipelineName: string; key: string; name: string }[];
  tags: Tag[];
  services: [string, string][];
};

export type EditorValue = { name: string; description: string; autoSend: boolean; trigger: Trigger; conditions: Condition[]; steps: Step[] };

/** A sensible starting shape for each step / condition / trigger type picked from a menu. */
function blankStep(type: Step["type"], o: EditorOptions): Step {
  switch (type) {
    case "WAIT": return { type, amount: 1, unit: "days" };
    case "SEND_EMAIL": return { type, subject: "", body: "Hi {{first_name}},\n\n\n\n{{brand_name}} · {{brand_phone}}" };
    case "SEND_SMS": return { type, body: "Hi {{first_name}}, this is {{brand_name}}. " };
    case "CREATE_TASK": return { type, title: "", dueInDays: 1 };
    case "ADD_TAG": case "REMOVE_TAG": return { type, tagId: o.tags[0]?.id ?? "", target: "contact" };
    case "MOVE_STAGE": return { type, stage: o.stages[0]?.key ?? "" };
    case "NOTIFY_OWNER": return { type, message: "" };
    case "STOP_IF_REPLIED": return { type };
  }
}
function blankCondition(type: Condition["type"], o: EditorOptions): Condition {
  switch (type) {
    case "SERVICE_IS": return { type, values: [o.services[0]?.[0] ?? ""] };
    case "BRAND_IS": return { type, value: "ESS" };
    case "HAS_TAG": case "NOT_TAG": return { type, tagId: o.tags[0]?.id ?? "" };
    case "HAS_EMAIL": case "HAS_PHONE": return { type };
  }
}
function blankTrigger(type: Trigger["type"], o: EditorOptions): Trigger {
  switch (type) {
    case "JOB_STAGE_ENTERED": return { type, stage: o.stages[0]?.key ?? "" };
    case "TAG_ADDED": return { type, tagId: o.tags[0]?.id ?? "", entity: "any" };
    case "JOB_CREATED": return { type };
    case "CONTACT_CREATED": return { type };
  }
}

const TARGETS = [["contact", "the person"], ["job", "the job"], ["organization", "the company"]] as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr] sm:items-center">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function StageSelect({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: EditorOptions; label: string }) {
  const groups = options.pipelines.map((p) => ({ p, stages: options.stages.filter((st) => st.pipelineKey === p.key) }));
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {groups.map(({ p, stages }) => (
        <optgroup key={p.key} label={p.name}>
          {stages.map((st) => <option key={`${p.key}:${st.key}`} value={st.key}>{st.name}</option>)}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

function TagSelect({ value, onChange, tags }: { value: string; onChange: (v: string) => void; tags: Tag[] }) {
  if (!tags.length) return <p className="text-sm text-muted-foreground">No tags yet: create one in Settings → Tags.</p>;
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label="Tag">
      {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </NativeSelect>
  );
}

export function WorkflowEditor({ initial, options, action, canEdit }: { initial: EditorValue; options: EditorOptions; action: (prev: ActionState, form: FormData) => Promise<ActionState>; canEdit: boolean }) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof EditorValue>(k: K, val: EditorValue[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const setStep = (i: number, s: Step) => set("steps", v.steps.map((x, j) => (j === i ? s : x)));
  const setCond = (i: number, c: Condition) => set("conditions", v.conditions.map((x, j) => (j === i ? c : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...v.steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set("steps", next);
  };
  const messages = v.steps.some((st) => OUTREACH_STEPS.includes(st.type));
  const t = v.trigger;

  return (
    <ActionForm action={action} className="space-y-4">
      <input type="hidden" name="definition" value={JSON.stringify({ trigger: v.trigger, conditions: v.conditions, steps: v.steps })} />
      <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-90">
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <Row label="Name"><Input name="name" value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Inspection scheduled → confirmation email" maxLength={100} required /></Row>
            <Row label="Notes"><Input name="description" value={v.description} onChange={(e) => set("description", e.target.value)} placeholder="What it's for (optional)" maxLength={500} /></Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>1. When…</CardTitle>
            <CardDescription>What starts this workflow. Only things that happen after it&apos;s switched on count.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Row label="Trigger">
              <NativeSelect value={t.type} onChange={(e) => set("trigger", blankTrigger(e.target.value as Trigger["type"], options))} aria-label="Trigger">
                {Object.entries(TRIGGER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </NativeSelect>
            </Row>
            {t.type === "JOB_STAGE_ENTERED" && (
              <Row label="Stage"><StageSelect value={t.stage} onChange={(stage) => set("trigger", { ...t, stage })} options={options} label="Stage" /></Row>
            )}
            {(t.type === "JOB_STAGE_ENTERED" || t.type === "JOB_CREATED") && (
              <Row label="Pipeline">
                <NativeSelect value={t.pipelineKey ?? ""} onChange={(e) => set("trigger", { ...t, pipelineKey: e.target.value || undefined })} aria-label="Pipeline">
                  <option value="">Any pipeline</option>
                  {options.pipelines.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                </NativeSelect>
              </Row>
            )}
            {t.type === "TAG_ADDED" && (
              <>
                <Row label="Tag"><TagSelect value={t.tagId} onChange={(tagId) => set("trigger", { ...t, tagId })} tags={options.tags} /></Row>
                <Row label="Added to">
                  <NativeSelect value={t.entity} onChange={(e) => set("trigger", { ...t, entity: e.target.value as typeof t.entity })} aria-label="Added to">
                    <option value="any">A person, company or job</option>
                    <option value="contact">A person</option>
                    <option value="organization">A company</option>
                    <option value="job">A job</option>
                  </NativeSelect>
                </Row>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Only if… <span className="text-sm font-normal text-muted-foreground">(optional)</span></CardTitle>
            <CardDescription>Every condition must be true when the workflow starts, or it&apos;s skipped for that record.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {v.conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2">
                <NativeSelect value={c.type} onChange={(e) => setCond(i, blankCondition(e.target.value as Condition["type"], options))} aria-label="Condition" className="w-auto">
                  {Object.entries(CONDITION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </NativeSelect>
                {c.type === "SERVICE_IS" && (
                  <NativeSelect value={c.values[0]} onChange={(e) => setCond(i, { ...c, values: [e.target.value] })} aria-label="Service" className="w-auto">
                    {options.services.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </NativeSelect>
                )}
                {c.type === "BRAND_IS" && (
                  <NativeSelect value={c.value} onChange={(e) => setCond(i, { ...c, value: e.target.value as "ESS" | "GAS_PRO" })} aria-label="Brand" className="w-auto">
                    <option value="ESS">ESS</option>
                    <option value="GAS_PRO">Gas Pro Inspectors</option>
                  </NativeSelect>
                )}
                {(c.type === "HAS_TAG" || c.type === "NOT_TAG") && <div className="w-auto"><TagSelect value={c.tagId} onChange={(tagId) => setCond(i, { ...c, tagId })} tags={options.tags} /></div>}
                <Button type="button" variant="ghost" size="sm" onClick={() => set("conditions", v.conditions.filter((_, j) => j !== i))} aria-label="Remove condition" className="ml-auto"><Trash2 /></Button>
              </div>
            ))}
            {canEdit && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => set("conditions", [...v.conditions, blankCondition("HAS_EMAIL", options)])}><Plus /> Add condition</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Then…</CardTitle>
            <CardDescription>
              Steps run in order. Messages, task names and notes can use{" "}
              {MESSAGE_TOKENS.map((tok, i) => <span key={tok}>{i ? ", " : ""}<code className="text-xs">{`{{${tok}}}`}</code></span>)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {v.steps.map((st, i) => (
              <div key={i} className="space-y-2 rounded-xl bg-card p-3 shadow-xs ring-1 ring-black/[0.06] dark:ring-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
                  <NativeSelect value={st.type} onChange={(e) => setStep(i, blankStep(e.target.value as Step["type"], options))} aria-label={`Step ${i + 1}`} className="w-auto">
                    {Object.entries(STEP_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </NativeSelect>
                  {st.type === "WAIT" && (
                    <>
                      <Input type="number" min={1} max={365} value={st.amount} onChange={(e) => setStep(i, { ...st, amount: Math.max(1, Number(e.target.value) || 1) })} aria-label="How long" className="w-20" />
                      <NativeSelect value={st.unit} onChange={(e) => setStep(i, { ...st, unit: e.target.value as typeof st.unit })} aria-label="Unit" className="w-auto">
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </NativeSelect>
                    </>
                  )}
                  {st.type === "MOVE_STAGE" && <div className="w-auto"><StageSelect value={st.stage} onChange={(stage) => setStep(i, { ...st, stage })} options={options} label="Stage" /></div>}
                  {(st.type === "ADD_TAG" || st.type === "REMOVE_TAG") && (
                    <>
                      <div className="w-auto"><TagSelect value={st.tagId} onChange={(tagId) => setStep(i, { ...st, tagId })} tags={options.tags} /></div>
                      <span className="text-sm text-muted-foreground">{st.type === "ADD_TAG" ? "to" : "from"}</span>
                      <NativeSelect value={st.target} onChange={(e) => setStep(i, { ...st, target: e.target.value as typeof st.target })} aria-label="Record" className="w-auto">
                        {TARGETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </NativeSelect>
                    </>
                  )}
                  {canEdit && (
                    <span className="ml-auto flex gap-1">
                      <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                      <Button type="button" variant="ghost" size="sm" disabled={i === v.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => set("steps", v.steps.filter((_, j) => j !== i))} aria-label="Remove step"><Trash2 /></Button>
                    </span>
                  )}
                </div>
                {st.type === "SEND_EMAIL" && (
                  <div className="grid gap-2 sm:pl-8">
                    <Input value={st.subject} onChange={(e) => setStep(i, { ...st, subject: e.target.value })} placeholder="Subject" maxLength={200} aria-label="Email subject" />
                    <Textarea value={st.body} onChange={(e) => setStep(i, { ...st, body: e.target.value })} rows={6} maxLength={5000} aria-label="Email body" />
                    <p className="text-xs text-muted-foreground">Goes to the person&apos;s first email, from the default sending address.</p>
                  </div>
                )}
                {st.type === "SEND_SMS" && (
                  <div className="grid gap-2 sm:pl-8">
                    <Textarea value={st.body} onChange={(e) => setStep(i, { ...st, body: e.target.value })} rows={3} maxLength={1000} aria-label="Text message" />
                    <p className="text-xs text-muted-foreground">Goes to the person&apos;s first phone, from the brand&apos;s Quo line. {st.body.length} characters.</p>
                  </div>
                )}
                {st.type === "CREATE_TASK" && (
                  <div className="flex flex-wrap items-center gap-2 sm:pl-8">
                    <Input value={st.title} onChange={(e) => setStep(i, { ...st, title: e.target.value })} placeholder="e.g. Call {{first_name}} about {{job_number}}" maxLength={200} aria-label="Task" className="min-w-56 flex-1" />
                    <span className="text-sm text-muted-foreground">due in</span>
                    <Input type="number" min={0} max={365} value={st.dueInDays} onChange={(e) => setStep(i, { ...st, dueInDays: Math.max(0, Number(e.target.value) || 0) })} aria-label="Due in days" className="w-20" />
                    <span className="text-sm text-muted-foreground">days</span>
                  </div>
                )}
                {st.type === "NOTIFY_OWNER" && (
                  <div className="sm:pl-8">
                    <Input value={st.message} onChange={(e) => setStep(i, { ...st, message: e.target.value })} placeholder="e.g. Hot lead {{first_name}} needs a call today" maxLength={500} aria-label="Message to the owner" />
                  </div>
                )}
                {st.type === "STOP_IF_REPLIED" && <p className="text-xs text-muted-foreground sm:pl-8">Ends here if the client called, texted or emailed since this workflow started.</p>}
                {st.type === "MOVE_STAGE" && <p className="text-xs text-muted-foreground sm:pl-8">The usual stage rules still apply (e.g. Delivered needs a final report); if a move is refused it&apos;s noted and the next step runs.</p>}
              </div>
            ))}
            {canEdit && (
              <NativeSelect value="" onChange={(e) => e.target.value && set("steps", [...v.steps, blankStep(e.target.value as Step["type"], options)])} aria-label="Add a step" className="w-auto">
                <option value="">+ Add a step…</option>
                {Object.entries(STEP_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </NativeSelect>
            )}
          </CardContent>
        </Card>

        {messages && (
          <Card className="border-amber-300/70">
            <CardContent className="space-y-1 pt-6">
              <div className="flex items-center gap-2">
                <input id="autoSend" type="checkbox" name="autoSend" checked={v.autoSend} onChange={(e) => set("autoSend", e.target.checked)} className="size-4 accent-primary" />
                <Label htmlFor="autoSend">Send emails and texts automatically</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Off (recommended to start): each message waits in the Outbox for someone to approve it. On: they go out by themselves during business hours,
                except a message with a blank field (like a missing date), which still waits for approval. AIRnyc cases and do-not-contact people are never messaged.
              </p>
            </CardContent>
          </Card>
        )}
      </fieldset>
      {canEdit ? <SubmitButton>Save workflow</SubmitButton> : <p className="text-sm text-muted-foreground">Only the owner can change workflows.</p>}
    </ActionForm>
  );
}
