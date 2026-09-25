"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { setJobStage } from "./actions";
import { LostReasonDialog } from "./lost-dialog";

export type BoardJob = {
  id: string;
  jobNumber: string;
  stage: string;
  service: string;
  address: string | null;
  client: string | null;
  daysInStage: number;
  stale: boolean;
  priority: string;
};

type Column = { key: string; name: string; isTerminal: boolean };

/**
 * Drag a card to another column to move it, or use the card's ⋯ menu (works on touch screens and keyboards,
 * where HTML drag-and-drop doesn't). Stage rules are enforced server-side (DB trigger).
 */
export function Kanban({ columns, jobs }: { columns: Column[]; jobs: BoardJob[] }) {
  const [optimistic, applyMove] = useOptimistic(jobs, (state, m: { id: string; stage: string }) =>
    state.map((j) => (j.id === m.id ? { ...j, stage: m.stage, daysInStage: 0, stale: false } : j)),
  );
  const [error, setError] = useState<string>();
  const [dragOver, setDragOver] = useState<string>();
  const [losing, setLosing] = useState<BoardJob>();
  const [pending, start] = useTransition();

  const commit = (job: BoardJob, stage: string, lostReason?: string) => {
    setError(undefined);
    start(async () => {
      applyMove({ id: job.id, stage });
      const res = await setJobStage(job.id, stage, lostReason);
      if (res.error) setError(`${job.jobNumber}: ${res.error}`);
      setLosing(undefined);
    });
  };

  const move = (id: string, stage: string) => {
    const job = optimistic.find((j) => j.id === id);
    if (!job || job.stage === stage) return;
    if (stage === "LOST") return setLosing(job);
    commit(job, stage);
  };

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => {
          const cards = optimistic.filter((j) => j.stage === col.key);
          return (
            <section
              key={col.key}
              aria-label={`${col.name}, ${cards.length} jobs`}
              onDragOver={(e) => (e.preventDefault(), setDragOver(col.key))}
              onDragLeave={() => setDragOver(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(undefined);
                move(e.dataTransfer.getData("text/job-id"), col.key);
              }}
              className={cn(
                "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40 p-2",
                col.isTerminal && "bg-muted/20",
                dragOver === col.key && "border-primary bg-sidebar-accent",
              )}
            >
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium">
                <span>{col.name}</span>
                <span className="text-muted-foreground">{cards.length}</span>
              </div>
              <div className="flex min-h-16 flex-col gap-2">
                {cards.map((j) => (
                  <div
                    key={j.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/job-id", j.id)}
                    className="group relative rounded-md border bg-card text-xs shadow-xs hover:border-primary"
                  >
                    <Link href={`/jobs/${j.id}`} className="block p-2 pr-8">
                      <div className="flex items-center gap-1">
                        <span className="font-mono">{j.jobNumber}</span>
                        {j.priority === "URGENT" || j.priority === "HIGH" ? <Badge variant="destructive">{j.priority.toLowerCase()}</Badge> : null}
                      </div>
                      <div className="mt-1 font-medium">{j.service}</div>
                      {j.address && <div className="truncate text-muted-foreground">{j.address}</div>}
                      {j.client && <div className="truncate text-muted-foreground">{j.client}</div>}
                      <div className={cn("mt-1 text-[11px]", j.stale ? "font-medium text-destructive" : "text-muted-foreground")}>
                        {j.daysInStage}d in stage{j.stale ? " · stale" : ""}
                      </div>
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" className="absolute top-1 right-1" aria-label={`Move ${j.jobNumber} to another stage`} />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuLabel>Move to…</DropdownMenuLabel>
                        {columns
                          .filter((c) => c.key !== j.stage)
                          .map((c) => (
                            <DropdownMenuItem key={c.key} variant={c.key === "LOST" ? "destructive" : "default"} onClick={() => move(j.id, c.key)}>
                              {c.name}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {losing && (
        <LostReasonDialog
          jobNumber={losing.jobNumber}
          open
          pending={pending}
          onOpenChange={(o) => o || setLosing(undefined)}
          onConfirm={(reason) => commit(losing, "LOST", reason)}
        />
      )}
    </div>
  );
}
