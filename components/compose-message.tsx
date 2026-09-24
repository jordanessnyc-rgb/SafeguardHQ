"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { composeMessage, renderTemplateFor } from "@/app/(app)/comms/actions";
import { formatPhone } from "@/lib/phone";

type Props = {
  phones: string[];
  emails: string[];
  lines: { id: string; label: string }[];
  templates: { key: string; name: string; channel: "SMS" | "EMAIL" }[];
  defaultFromEmail: string;
  context: { contactId?: string; jobId?: string; airnycCaseId?: string };
  revalidate: string;
  isOwner: boolean;
};

/** Draft or send an SMS/email. "Send now" is itself a human approval; drafts go to the Outbox. */
export function ComposeMessage(p: Props) {
  const [channel, setChannel] = useState<"SMS" | "EMAIL">(p.phones.length ? "SMS" : "EMAIL");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const recipients = channel === "SMS" ? p.phones : p.emails;

  const applyTemplate = (key: string) => {
    setTemplateKey(key);
    if (!key) return;
    start(async () => {
      const r = await renderTemplateFor(key, { contactId: p.context.contactId, jobId: p.context.jobId });
      setBody(r.text);
      if (r.subject) setSubject(r.subject);
      setMissing(r.missing);
    });
  };

  if (!p.phones.length && !p.emails.length) {
    return <p className="text-sm text-muted-foreground">Add a phone number or email to this contact to message them.</p>;
  }

  return (
    <ActionForm action={composeMessage} className="space-y-3">
      {Object.entries(p.context).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="revalidate" value={p.revalidate} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="templateKey" value={templateKey} />
      <div className="flex gap-1">
        {(["SMS", "EMAIL"] as const).map((c) => (
          <button
            key={c}
            type="button"
            disabled={c === "SMS" ? !p.phones.length : !p.emails.length}
            onClick={() => (setChannel(c), setTemplateKey(""))}
            className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${channel === c ? "border-primary bg-primary text-primary-foreground" : ""}`}
          >
            {c === "SMS" ? "Text" : "Email"}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="To">
          <NativeSelect name="to" key={channel}>
            {recipients.map((r) => (
              <option key={r} value={r}>
                {channel === "SMS" ? formatPhone(r) : r}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {channel === "SMS" ? (
          <Field label="From line">
            <NativeSelect name="fromLineId">
              {p.lines.length === 0 && <option value="">No Quo lines configured (Settings)</option>}
              {p.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : (
          <Field label="From">
            <Input name="fromEmail" defaultValue={p.defaultFromEmail} />
          </Field>
        )}
      </div>
      <Field label="Template">
        <NativeSelect value={templateKey} onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">— none —</option>
          {p.templates
            .filter((t) => t.channel === channel)
            .map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
        </NativeSelect>
      </Field>
      {channel === "EMAIL" && (
        <Field label="Subject">
          <Input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      )}
      <Field label="Message" hint={channel === "SMS" ? `${body.length} characters (160 per SMS segment)` : undefined}>
        <Textarea name="body" rows={channel === "SMS" ? 3 : 8} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} />
      </Field>
      {missing.length > 0 && <p className="text-xs text-amber-700">Not filled in (no data yet): {missing.join(", ")} — edit before sending.</p>}
      {p.isOwner && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="containsPricing" className="size-4 accent-primary" /> Includes pricing (hidden from VAs)
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm" variant="outline" name="intent" value="draft">
          Save draft
        </SubmitButton>
        <SubmitButton size="sm" name="intent" value="send">
          Send now
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
