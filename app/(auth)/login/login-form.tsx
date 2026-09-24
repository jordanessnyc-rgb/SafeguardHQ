"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {});
  if (state.ok) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        If that address has an account, a sign-in link is on its way. Check your inbox.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@ess-nyc.com" />
      </div>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
