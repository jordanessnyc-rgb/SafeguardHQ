"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/actions";

type State = ActionState & { token?: string };

export function NewTokenForm({ action, endpoint }: { action: (prev: State, form: FormData) => Promise<State>; endpoint: string }) {
  const [state, formAction] = useActionState<State, FormData>(action, {});
  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          Name
          <Input name="label" placeholder="Jordan’s laptop" className="w-64" required maxLength={80} />
        </label>
        <SubmitButton size="sm">Create token</SubmitButton>
      </form>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {state.token && (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <p className="font-medium">Copy this token now — it won’t be shown again.</p>
          <code className="block break-all rounded bg-background p-2 text-xs">{state.token}</code>
          <p>Claude Code (terminal):</p>
          <code className="block break-all rounded bg-background p-2 text-xs">
            claude mcp add --transport http ess-crm {endpoint} --header &quot;Authorization: Bearer {state.token}&quot;
          </code>
        </div>
      )}
    </div>
  );
}
