"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN } from "@/lib/auth/password";
import { changePassword, type PasswordState } from "./actions";

export function PasswordForm({ home }: { home: string }) {
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePassword, {});
  if (state.ok) {
    return (
      <div className="space-y-3 text-sm">
        <p role="status">Password saved. Use it with your email next time you sign in.</p>
        <Link href={home} className={buttonVariants({ className: "w-full" })}>
          Continue
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required aria-describedby="password-hint" />
        <p id="password-hint" className="text-xs text-muted-foreground">
          At least {PASSWORD_MIN} characters. A short phrase is easiest to remember.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Type it again</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? "Saving…" : "Save password"}
      </Button>
    </form>
  );
}
