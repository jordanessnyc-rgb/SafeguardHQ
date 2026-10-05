"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { fetchQuoCallDetails } from "@/app/(app)/comms/quo-actions";
import type { QuoCallDetails as Details } from "@/lib/comms/quo-call-details";

export function QuoCallDetails({ activityId }: { activityId: string }) {
  const [details, setDetails] = useState<Details>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return <div className="mt-2 space-y-2">
    <Button size="xs" variant="outline" disabled={pending} onClick={() => start(async () => {
      setError(undefined);
      try { const result = await fetchQuoCallDetails(activityId); setDetails(result.details); setError(result.error); }
      catch { setError("Could not load the call. Check your connection and try again."); }
    })}>{pending ? "Loading Quo call…" : details ? "Refresh Quo call details" : "Load Quo call details"}</Button>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {details && <div className="space-y-3 rounded-lg border p-3" aria-live="polite">
      <p className="text-xs text-muted-foreground">Loaded from Quo for this view. These details aren’t saved to the job. Refresh if an audio link expires.</p>
      <section aria-label="Call recordings"><h4 className="font-medium">Recordings</h4>
        {details.recordings.message && <p className="text-xs text-muted-foreground">{details.recordings.message}</p>}
        {details.recordings.data?.length === 0 && <p className="text-xs text-muted-foreground">No completed recording available.</p>}
        {details.recordings.data?.map((r, i) => <div key={r.url} className="mt-1"><p className="text-xs">Recording {i + 1}</p><audio controls preload="none" className="w-full max-w-md" aria-label={`Call recording ${i + 1}`} src={r.url} /></div>)}
      </section>
      <section aria-label="Voicemail"><h4 className="font-medium">Voicemail</h4>
        {details.voicemail.message && <p className="text-xs text-muted-foreground">{details.voicemail.message}</p>}
        {details.voicemail.data?.url && <audio controls preload="none" className="w-full max-w-md" aria-label="Voicemail recording" src={details.voicemail.data.url} />}
        {details.voicemail.data?.transcript && <p className="whitespace-pre-line">{details.voicemail.data.transcript}</p>}
      </section>
      <section aria-label="Quo call summary"><h4 className="font-medium">Call summary</h4>
        {details.summary.message && <p className="text-xs text-muted-foreground">{details.summary.message}</p>}
        {details.summary.data && <><p className="whitespace-pre-line">{details.summary.data.text || "No summary text available."}</p><ul className="list-disc pl-5">{details.summary.data.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
      </section>
      <details><summary className="cursor-pointer font-medium">Full Quo transcript</summary><p className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap">{details.transcript.message ?? (details.transcript.data || "No transcript text available.")}</p></details>
      <Button size="xs" variant="ghost" onClick={() => setDetails(undefined)}>Hide call details</Button>
    </div>}
  </div>;
}
