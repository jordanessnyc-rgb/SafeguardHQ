"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { composeMessage, renderTemplateFor } from "@/app/(app)/comms/actions";
import { formatPhone } from "@/lib/phone";

export type ComposeInitial = {
  channel?: "SMS" | "EMAIL";
  to?: string;
  cc?: string[];
  subject?: string;
  body?: string;
  /** Message-ID being answered (threads the reply in the recipient's mail app). */
  inReplyTo?: string | null;
  fromLineId?: string;
};

type Props = {
  phones: string[];
  emails: string[];
  lines: { id: string; label: string }[];
  templates: { key: string; name: string; channel: "SMS" | "EMAIL" }[];
  defaultFromEmail: string;
  context: { contactId?: string; jobId?: string; airnycCaseId?: string };
  revalidate: string;
  isOwner: boolean;
  /** Type any address/number instead of picking from the contact's. */
  freeTo?: boolean;
  initial?: ComposeInitial;
  /** Job documents that can be attached to an email. */
  documents?: { id: string; title: string; containsPricing: boolean }[];
  onSent?: () => void;
};

/** Draft or send an SMS/email. "Send now" is itself a human approval; drafts go to the Outbox. */
export function ComposeMessage(p: Props) {
  const init = p.initial ?? {};
  const [channel, setChannel] = useState<"SMS" | "EMAIL">(init.channel ?? (p.phones.length ? "SMS" : "EMAIL"));
  const [body, setBody] = useState(init.body ?? "");
  const [subject, setSubject] = useState(init.subject ?? "");
  const [templateKey, setTemplateKey] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const recipients = channel === "SMS" ? p.phones : p.emails;
  const freeTo = p.freeTo || (channel === "SMS" ? !p.phones.length : !p.emails.length);

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

  if (!p.freeTo && !p.phones.length && !p.emails.length) {
    return <p className="text-sm text-muted-foreground">Add a phone number or email to this contact to message them.</p>;
  }

  return (
    <ActionForm action={composeMessage} className="space-y-3" successMessage="Sent." onSuccess={p.onSent}>
      {Object.entries(p.context).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="revalidate" value={p.revalidate} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="templateKey" value={templateKey} />
      {init.inReplyTo && channel === "EMAIL" && <input type="hidden" name="inReplyTo" value={init.inReplyTo} />}
      {!init.channel && (
        <div className="flex gap-1">
          {(["SMS", "EMAIL"] as const).map((c) => (
            <button
              key={c}
              type="button"
              disabled={!p.freeTo && (c === "SMS" ? !p.phones.length : !p.emails.length)}
              onClick={() => (setChannel(c), setTemplateKey(""))}
              className={`rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${channel === c ? "border-primary bg-primary text-primary-foreground" : ""}`}
            >
              {c === "SMS" ? "Text" : "Email"}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="To">
          {freeTo ? (
            <Input name="to" key={channel} type={channel === "SMS" ? "tel" : "email"} defaultValue={init.to ?? ""} placeholder={channel === "SMS" ? "(212) 555-0100" : "name@example.com"} required list={channel === "SMS" ? "compose-phones" : "compose-emails"} />
          ) : (
            <NativeSelect name="to" key={channel} defaultValue={init.to}>
              {recipients.map((r) => (
                <option key={r} value={r}>
                  {channel === "SMS" ? formatPhone(r) : r}
                </option>
              ))}
            </NativeSelect>
          )}
          {freeTo && p.phones.length > 0 && <datalist id="compose-phones">{p.phones.map((x) => <option key={x} value={x} />)}</datalist>}
          {freeTo && p.emails.length > 0 && <datalist id="compose-emails">{p.emails.map((x) => <option key={x} value={x} />)}</datalist>}
        </Field>
        {channel === "SMS" ? (
          <Field label="From line">
            <NativeSelect name="fromLineId" defaultValue={init.fromLineId}>
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
      {channel === "EMAIL" && (
        <Field label="Cc" hint="Separate addresses with commas.">
          <Input name="cc" defaultValue={(init.cc ?? []).join(", ")} placeholder="optional" />
        </Field>
      )}
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
      {channel === "EMAIL" && (p.documents?.length ?? 0) > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="text-sm font-medium">Attach from the job</legend>
          {p.documents!.map((d) => (
            <label key={d.id} className="flex items-center gap-2">
              <input type="checkbox" name="attachmentId" value={d.id} className="size-4 accent-primary" disabled={d.containsPricing && !p.isOwner} />
              <span className="truncate">{d.title}</span>
              {d.containsPricing && <span className="text-xs text-muted-foreground">(has pricing)</span>}
            </label>
          ))}
        </fieldset>
      )}
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
