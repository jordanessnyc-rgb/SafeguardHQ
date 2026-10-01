"use client";

import { useActionState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ActionState } from "@/lib/actions";

/**
 * Files the message. The page then re-renders without it and opens the one that took its place
 * (see `at` in the inbox page), like archiving in a mail app. The toast is raised straight from
 * the action's result: this form is usually gone by the time React would run an effect.
 */
export function FileForm({ action, className, children }: { action: (prev: ActionState, form: FormData) => Promise<ActionState>; className?: string; children: ReactNode }) {
  const [state, formAction] = useActionState<ActionState, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    if (r.ok) toast.success(r.message || "Filed.");
    return r;
  }, {});
  return (
    <form action={formAction} className={className}>
      {children}
      {state.error && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
