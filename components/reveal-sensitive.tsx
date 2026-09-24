"use client";

import { useState, useTransition } from "react";
import { Lock } from "lucide-react";
import { revealSensitive } from "@/app/(app)/comms/actions";
import type { SensitiveContent } from "@/lib/comms/sensitive";

/** AIRnyc content stays sealed until someone clicks — and every reveal is written to the audit log. */
export function RevealSensitive({ activityId }: { activityId: string }) {
  const [content, setContent] = useState<SensitiveContent | null>(null);
  const [pending, start] = useTransition();
  if (!content) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setContent(await revealSensitive(activityId)))}
        className="inline-flex items-center gap-1 text-xs text-amber-800 hover:underline"
      >
        <Lock className="size-3" /> {pending ? "Decrypting…" : "Protected AIRnyc content — reveal (logged)"}
      </button>
    );
  }
  return (
    <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-sm">
      {content.subject && <div className="font-medium">{content.subject}</div>}
      {content.summary && <div className="whitespace-pre-line">{content.summary}</div>}
      {content.body && <div className="whitespace-pre-line">{content.body}</div>}
      {content.transcript && (
        <details>
          <summary className="cursor-pointer text-xs">Transcript</summary>
          <pre className="text-xs whitespace-pre-wrap">{content.transcript}</pre>
        </details>
      )}
    </div>
  );
}
