"use client";

import { cloneElement, isValidElement, useActionState, useEffect, useId, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ActionState } from "@/lib/actions";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** A <form> bound to a server action: errors show inline, success shows as a toast. */
export function ActionForm({
  action,
  children,
  className,
  successMessage,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  successMessage?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  // Every successful save gets a "Saved" toast; errors stay next to the form, where the fix is.
  useEffect(() => {
    if (state.ok) toast.success(state.message || successMessage || "Saved");
  }, [state, successMessage]);
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

export function SubmitButton({
  children,
  className,
  variant,
  size,
  name,
  value,
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "lg" | "xs";
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className} variant={variant} size={size} name={name} value={value}>
      {pending ? "Saving…" : children}
    </Button>
  );
}

export function Field({ label, htmlFor, children, hint, className }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  const generated = useId();
  const id = htmlFor ?? `field-${generated}`;
  const control = isValidElement(children) ? children as ReactElement<{ id?: string; "aria-describedby"?: string }> : null;
  const controlId = control?.props.id ?? id;
  const hintId = `${controlId}-hint`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {control ? cloneElement(control, {
        id: controlId,
        "aria-describedby": [control.props["aria-describedby"], hint ? hintId : undefined].filter(Boolean).join(" ") || undefined,
      }) : children}
      {hint && <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
