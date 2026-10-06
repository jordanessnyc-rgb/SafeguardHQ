"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset, signIn, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {});
  const [reset, resetAction, resetPending] = useActionState<LoginState, FormData>(requestPasswordReset, {});

  if (mode === "reset") {
    if (reset.ok) {
      return (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground" role="status">
            If that address has an account, an email with a link to set a new password is on its way.
          </p>
          <Button type="button" variant="outline" className="w-full" onClick={() => setMode("signin")}>
            Back to sign in
          </Button>
        </div>
      );
    }
    return (
      <form action={resetAction} className="space-y-3">
        <p className="text-sm text-muted-foreground">Enter your email and we&apos;ll send a link to set a new password.</p>
        <div className="space-y-1.5">
          <Label htmlFor="reset-email">Email</Label>
          <Input id="reset-email" name="email" type="email" autoComplete="email" required defaultValue={reset.email} />
        </div>
        {reset.error && <p className="text-sm text-destructive">{reset.error}</p>}
        <Button type="submit" className="w-full" size="lg" disabled={resetPending}>
          {resetPending ? "Sending…" : "Email me a reset link"}
        </Button>
        <button type="button" className="w-full text-center text-sm text-muted-foreground underline" onClick={() => setMode("signin")}>
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required placeholder="you@ess-nyc.com" defaultValue={state.email} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">Password</Label>
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setMode("reset")}>
            Forgot password?
          </button>
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
