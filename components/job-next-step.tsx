import Link from "next/link";
import { JobActions } from "@/app/(app)/jobs/[id]/job-actions";
import { buttonVariants } from "@/components/ui/button";
import type { JobStep } from "@/lib/jobs/next-step";
import { cn } from "@/lib/utils";

type StageOption = { key: string; name: string; blocked: string[] };

export function JobNextStep({ jobId, jobNumber, step, next, stages, canMarkLost }: { jobId: string; jobNumber: string; step: JobStep; next: StageOption | null; stages: StageOption[]; canMarkLost: boolean }) {
  return (
    <section aria-label="Next step" className="mb-4 rounded-xl border border-primary/25 bg-sidebar p-4 sm:p-5">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="max-w-2xl">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">Next step</p>
          <h2 className="text-lg font-semibold">{step.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
          {step.action && <Link href={step.calendar ? "/schedule" : `/jobs/${jobId}?tab=${step.tab}`} className={cn(buttonVariants(), "mt-3")}>{step.action}</Link>}
        </div>
        <div className="flex flex-col items-start gap-2 xl:items-end">
          <JobActions jobId={jobId} jobNumber={jobNumber} next={next} stages={stages} canMarkLost={canMarkLost} />
          {next && <p className="max-w-xs text-right text-xs text-muted-foreground">Record a status only after the work is done. Configured automations may run.</p>}
        </div>
      </div>
      {next?.key === "DELIVERED" && <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">Recording Delivered sets the workflow delivery date and can create an invoice. If automatic invoice sending is enabled, that invoice may be emailed to the client. Check the payment hold in Proposal &amp; billing before sending the report.</p>}
    </section>
  );
}
