"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowRight, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { archiveJob, setJobStage } from "../actions";
import { LostReasonDialog } from "../lost-dialog";

type StageOption = { key: string; name: string; blocked: string[] };

/**
 * The job header's actions: one primary "Advance to <next stage>" button (disabled, with the reason,
 * when a stage rule blocks it), and a ⋯ menu for everything less common — moving to any other stage,
 * marking lost (asks why), editing details, archiving (asks to confirm).
 */
export function JobActions({
  jobId,
  jobNumber,
  next,
  stages,
  canMarkLost,
}: {
  jobId: string;
  jobNumber: string;
  next: StageOption | null;
  stages: StageOption[];
  canMarkLost: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [losing, setLosing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const move = (stage: string, lostReason?: string) => {
    setError(undefined);
    start(async () => {
      const res = await setJobStage(jobId, stage, lostReason);
      if (res.error) setError(res.error);
      else setLosing(false);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon-lg" aria-label="More actions" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem render={<Link href={`/jobs/${jobId}?tab=edit`} />}>Edit job details</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
              {stages
                .filter((st) => st.key !== "LOST")
                .map((st) => (
                  <DropdownMenuItem key={st.key} disabled={pending || st.blocked.length > 0} onClick={() => move(st.key)}>
                    {st.name}
                    {st.blocked.length > 0 && <span className="ml-auto text-xs text-muted-foreground">blocked</span>}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {canMarkLost && (
              <DropdownMenuItem variant="destructive" onClick={() => setLosing(true)}>
                Mark as lost…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => setArchiving(true)}>
              Archive job…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {next && (
          <Button size="lg" disabled={pending || next.blocked.length > 0} onClick={() => move(next.key)} title={next.blocked.join(" ") || undefined}>
            {pending ? "Moving…" : `Advance to ${next.name}`}
            <ArrowRight />
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-md text-right text-sm text-destructive">
          {error}
        </p>
      )}

      <LostReasonDialog jobNumber={jobNumber} open={losing} pending={pending} onOpenChange={setLosing} onConfirm={(reason) => move("LOST", reason)} />

      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {jobNumber}?</DialogTitle>
            <DialogDescription>It disappears from boards, lists and the dashboard. Its records, documents and history are kept.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(false)}>Cancel</Button>
            <form action={archiveJob.bind(null, jobId)}>
              <Button type="submit" variant="destructive">Archive job</Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
