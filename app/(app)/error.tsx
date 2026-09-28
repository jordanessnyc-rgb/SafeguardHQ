"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/** Keeps the menu on screen when one page fails, instead of a blank white error. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold">This page didn&apos;t load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong on our side. Nothing you entered was lost unless you were in the middle of saving. Try again, and if it keeps happening, tell Claude what you clicked
        {error.digest ? <> and this code: <code className="font-mono">{error.digest}</code></> : null}.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>Go to the dashboard</Link>
      </div>
    </div>
  );
}
