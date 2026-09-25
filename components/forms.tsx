"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ActionState } from "@/lib/actions";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** A <form> bound to a server action that shows the action's error/success message inline. */
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
  return (
    <form action={formAction} className={className}>
      {children}
      {state.error && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.ok && (state.message || successMessage) && (
        <p role="status" className="basis-full text-sm text-primary">
          {state.message || successMessage}
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
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
