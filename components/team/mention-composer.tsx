"use client";

import { useId, useRef } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/actions";
import type { Member } from "@/lib/team/mentions";

/**
 * A text box for internal notes and team chat. The "Mention" buttons insert @Name at the cursor;
 * anyone mentioned gets a notification. Ctrl/⌘+Enter sends.
 */
export function MentionComposer({
  action,
  members,
  me,
  placeholder,
  submitLabel,
  hint,
  rows = 3,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  members: Member[];
  me: string;
  placeholder: string;
  submitLabel: string;
  hint?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const others = members.filter((m) => m.id !== me);

  const insert = (m: Member) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const text = `${pad}@${m.name} `;
    el.setRangeText(text, start, el.selectionEnd ?? start, "end");
    el.focus();
  };

  return (
    <ActionForm
      action={action}
      className="space-y-2"
      onSuccess={() => {
        if (ref.current) ref.current.value = "";
      }}
    >
      <label htmlFor={id} className="sr-only">{placeholder}</label>
      <Textarea
        ref={ref}
        id={id}
        name="body"
        rows={rows}
        maxLength={4000}
        required
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {others.length > 0 && <span className="text-xs text-muted-foreground">Mention:</span>}
        {others.map((m) => (
          <button key={m.id} type="button" onClick={() => insert(m)} className="rounded-full bg-card px-2 py-0.5 text-xs ring-1 ring-black/[0.08] hover:bg-primary/10 hover:text-primary dark:ring-white/10">
            @{m.name}
          </button>
        ))}
        <SubmitButton size="sm" className="ml-auto">{submitLabel}</SubmitButton>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </ActionForm>
  );
}
