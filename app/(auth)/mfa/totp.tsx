"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { startEnroll, verifyCode, type EnrollState, type VerifyState } from "./actions";

/** 6-digit code form. With `next`, a correct code redirects there; without, it just confirms. */
export function CodeForm({ factorId, next, submitLabel = "Verify" }: { factorId: string; next?: string; submitLabel?: string }) {
  const [state, action, pending] = useActionState<VerifyState, FormData>(verifyCode, {});
  if (state.ok) return <p role="status" className="text-sm text-primary">Authenticator added.</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="factorId" value={factorId} />
      {next !== undefined && <input type="hidden" name="next" value={next} />}
      <div className="space-y-1.5">
        <Label htmlFor="code">6-digit code</Label>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus className="text-lg tracking-widest" />
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Checking…" : submitLabel}</Button>
    </form>
  );
}

/** Enrollment: show a QR code + secret, then confirm with a code from the app. */
export function EnrollTotp({ next }: { next?: string }) {
  const [enroll, setEnroll] = useState<EnrollState | null>(null);
  const [pending, start] = useTransition();
  const begin = () => start(async () => setEnroll(await startEnroll()));

  if (!enroll?.factorId) {
    return (
      <div className="space-y-2">
        {enroll?.error && <p role="alert" className="text-sm text-destructive">{enroll.error}</p>}
        <Button type="button" onClick={begin} disabled={pending}>{pending ? "Preparing…" : "Set up an authenticator app"}</Button>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <ol className="list-decimal space-y-1 pl-5">
        <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>Scan this code, or type the key below.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URL SVG from Supabase */}
      <img src={enroll.qr} alt="QR code for your authenticator app" className="mx-auto size-48 rounded bg-white p-2" />
      <code className="block break-all rounded bg-muted p-2 text-center text-xs">{enroll.secret}</code>
      <CodeForm factorId={enroll.factorId} next={next} submitLabel="Turn on two-step sign-in" />
    </div>
  );
}
