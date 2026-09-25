"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A settings on/off row: a real checkbox (so forms and screen readers work as usual) drawn as a switch.
 * `risky` marks switches that let things reach clients without review; when on they say so.
 */
export function SwitchRow({ name, label, hint, defaultChecked, disabled, risky }: { name: string; label: string; hint?: ReactNode; defaultChecked: boolean; disabled?: boolean; risky?: boolean }) {
  // Uncontrolled + CSS (group-has-checked) so a form reset (Discard) also resets how it looks.
  return (
    <label className={cn("group flex items-start gap-4 py-3.5", disabled ? "cursor-default" : "cursor-pointer")}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {label}
          {risky && <span className="hidden rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900 group-has-checked:inline dark:bg-amber-950 dark:text-amber-200">Sends without review</span>}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" name={name} defaultChecked={defaultChecked} disabled={disabled} className="peer sr-only" />
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-11 shrink-0 items-center justify-start rounded-full bg-input p-0.5 transition-colors group-has-checked:justify-end group-has-checked:bg-primary peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:opacity-60"
      >
        <span className="size-5 rounded-full bg-white shadow-sm" />
      </span>
    </label>
  );
}

/**
 * Sticky save bar for a settings section form: shows once something changes, with Discard (reset the
 * form) and Save. Place it inside the <form>.
 */
export function SaveBar({ label = "Save changes" }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);
  const { pending } = useFormStatus();
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const mark = () => setDirty(true);
    const clear = () => setDirty(false);
    form.addEventListener("input", mark);
    form.addEventListener("change", mark);
    form.addEventListener("reset", clear);
    return () => {
      form.removeEventListener("input", mark);
      form.removeEventListener("change", mark);
      form.removeEventListener("reset", clear);
    };
  }, []);
  // After a save finishes, the form's values are the saved ones.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) setDirty(false);
    wasPending.current = pending;
  }, [pending]);
  return (
    <div
      ref={ref}
      className={cn(
        "sticky bottom-16 z-10 -mx-4 mt-4 flex items-center gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur md:bottom-0",
        !dirty && "static mx-0 border-t-0 bg-transparent px-0 backdrop-blur-none",
      )}
    >
      {dirty && (
        <>
          <span aria-hidden className="size-2 rounded-full bg-amber-500" />
          <span className="flex-1 text-sm">Unsaved changes</span>
          <Button type="reset" variant="outline" disabled={pending}>
            Discard
          </Button>
        </>
      )}
      <Button type="submit" disabled={pending || !dirty}>
        {pending ? "Saving…" : label}
      </Button>
    </div>
  );
}
