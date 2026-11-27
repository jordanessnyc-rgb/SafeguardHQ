"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, EyeOff, Mail, MessageSquare, Send } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionState } from "@/lib/actions";
import { formatPhone } from "@/lib/phone";
import type { Member } from "@/lib/team/mentions";
import { cn } from "@/lib/utils";

/** "Select all" for the conversation list: ticks every row checkbox in the same form. */
export function SelectAll() {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        onChange={(e) => e.currentTarget.form?.querySelectorAll<HTMLInputElement>('input[name="key"]').forEach((b) => (b.checked = e.currentTarget.checked))}
      />
      Select all
    </label>
  );
}

export type Channel = "SMS" | "EMAIL" | "INTERNAL";
const META: Record<Channel, { label: string; icon: typeof Mail }> = {
  SMS: { label: "SMS", icon: MessageSquare },
  EMAIL: { label: "Email", icon: Mail },
  INTERNAL: { label: "Internal comment", icon: EyeOff },
};

/**
 * The conversation's one-line message bar with a channel picker (SMS / Email / Internal comment).
 * SMS and Email are sent straight away by the person typing; an internal comment stays in the team.
 */
export function ConversationComposer({
  action,
  initial,
  sms,
  email,
  internal,
  members,
  me,
  context,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  initial: Channel;
  sms: { to: string; lines: { id: string; label: string }[]; defaultLineId?: string } | null;
  email: { to: string; fromEmail: string; subject: string; inReplyTo: string | null } | null;
  internal: boolean;
  members: Member[];
  me: string;
  context: { contactId?: string | null; jobId?: string | null };
}) {
  const available = (["SMS", "EMAIL", "INTERNAL"] as Channel[]).filter((c) => (c === "SMS" ? sms : c === "EMAIL" ? email : internal));
  const [channel, setChannel] = useState<Channel>(available.includes(initial) ? initial : (available[0] ?? "INTERNAL"));
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  if (!available.length) return <p className="p-3 text-sm text-muted-foreground">No phone or email on file to reply to.</p>;
  const Icon = META[channel].icon;
  const others = members.filter((m) => m.id !== me);

  return (
    <ActionForm
      action={action}
      className={cn("space-y-2 border-t p-3", channel === "INTERNAL" && "bg-amber-50/60 dark:bg-amber-950/20")}
      onSuccess={() => {
        if (box.current) box.current.value = "";
      }}
    >
      <input type="hidden" name="channel" value={channel} />
      {context.contactId && <input type="hidden" name="contactId" value={context.contactId} />}
      {context.jobId && <input type="hidden" name="jobId" value={context.jobId} />}
      {channel === "SMS" && sms && <input type="hidden" name="to" value={sms.to} />}
      {channel === "EMAIL" && email && (
        <>
          <input type="hidden" name="to" value={email.to} />
          <input type="hidden" name="fromEmail" value={email.fromEmail} />
          {email.inReplyTo && <input type="hidden" name="inReplyTo" value={email.inReplyTo} />}
          <Input name="subject" defaultValue={email.subject} maxLength={300} placeholder="Subject" aria-label="Subject" className="h-8 text-sm" />
        </>
      )}
      {channel === "SMS" && sms && sms.lines.length > 1 && (
        <NativeSelect name="fromLineId" defaultValue={sms.defaultLineId ?? sms.lines[0].id} aria-label="Send from line" className="h-8 w-auto text-xs">
          {sms.lines.map((l) => <option key={l.id} value={l.id}>From {l.label}</option>)}
        </NativeSelect>
      )}
      {channel === "SMS" && sms && sms.lines.length === 1 && <input type="hidden" name="fromLineId" value={sms.lines[0].id} />}
      <div className="flex items-end gap-2 rounded-xl border bg-card p-1.5 shadow-xs focus-within:border-primary/50">
        <div ref={menuRef} className="relative">
          <button type="button" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label={`Channel: ${META[channel].label}`} className="flex h-8 items-center gap-1 rounded-lg px-2 text-primary hover:bg-muted">
            <Icon className="size-4" />
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
          {menu && (
            <div role="menu" className="absolute bottom-10 left-0 z-20 w-52 rounded-xl bg-popover p-1 shadow-pop ring-1 ring-black/[0.08] dark:ring-white/10">
              {available.map((c) => {
                const I = META[c].icon;
                return (
                  <button key={c} type="button" role="menuitemradio" aria-checked={channel === c} onClick={() => (setChannel(c), setMenu(false), box.current?.focus())} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted">
                    <I className="size-4 text-muted-foreground" />
                    <span className="flex-1 text-left">{META[c].label}</span>
                    {channel === c && <Check className="size-4 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <textarea
          ref={box}
          name="body"
          rows={1}
          required
          maxLength={channel === "SMS" ? 1600 : 20000}
          placeholder={channel === "INTERNAL" ? "Write an internal comment… only your team sees it" : `Type a message (${META[channel].label})`}
          aria-label="Message"
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none field-sizing-content"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <SubmitButton size="sm" className="h-8">
          <Send /> {channel === "INTERNAL" ? "Add" : "Send"}
        </SubmitButton>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {channel === "INTERNAL" ? (
          <>
            <span>Only your team sees this. Mention:</span>
            {others.map((m) => (
              <button key={m.id} type="button" onClick={() => box.current && (box.current.setRangeText(`@${m.name} `, box.current.selectionStart ?? box.current.value.length, box.current.selectionEnd ?? box.current.value.length, "end"), box.current.focus())} className="rounded-full bg-card px-2 py-0.5 ring-1 ring-black/[0.08] hover:text-primary dark:ring-white/10">
                @{m.name}
              </button>
            ))}
          </>
        ) : (
          <span>
            {channel === "SMS" ? `Texting ${formatPhone(sms?.to ?? "")}` : `Emailing ${email?.to}`} · Ctrl/⌘ + Enter to send. Needs a template or drafts? Use <a href="/outbox" className="underline">Drafts &amp; approvals</a>.
          </span>
        )}
      </div>
    </ActionForm>
  );
}
