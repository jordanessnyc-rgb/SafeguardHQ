"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { setJobStage } from "./actions";

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

/** Drag a card to another column to move it. Stage rules are enforced server-side (DB trigger). */
export function Kanban({ columns, jobs }: { columns: Column[]; jobs: BoardJob[] }) {
  const [optimistic, applyMove] = useOptimistic(jobs, (state, m: { id: string; stage: string }) =>
    state.map((j) => (j.id === m.id ? { ...j, stage: m.stage, daysInStage: 0, stale: false } : j)),
  );
  const [error, setError] = useState<string>();
  const [dragOver, setDragOver] = useState<string>();
  const [, start] = useTransition();

  const move = (id: string, stage: string) => {
    const job = optimistic.find((j) => j.id === id);
    if (!job || job.stage === stage) return;
    let lostReason: string | undefined;
    if (stage === "LOST") {
      lostReason = window.prompt(`Why was ${job.jobNumber} lost?`)?.trim();
      if (!lostReason) return;
    }
    setError(undefined);
    start(async () => {
      applyMove({ id, stage });
      const res = await setJobStage(id, stage, lostReason);
      if (res.error) setError(`${job.jobNumber}: ${res.error}`);
    });
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
            <div
              key={col.key}
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
                  <Link
                    key={j.id}
                    href={`/jobs/${j.id}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/job-id", j.id)}
                    className="rounded-md border bg-card p-2 text-xs shadow-xs hover:border-primary"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono">{j.jobNumber}</span>
                      {j.priority === "URGENT" || j.priority === "HIGH" ? <Badge variant="destructive">{j.priority.toLowerCase()}</Badge> : null}
                    </div>
                    <div className="mt-1 font-medium">{j.service}</div>
                    {j.address && <div className="truncate text-muted-foreground">{j.address}</div>}
                    {j.client && <div className="truncate text-muted-foreground">{j.client}</div>}
                    <div className={cn("mt-1 text-[10px]", j.stale ? "font-medium text-destructive" : "text-muted-foreground")}>
                      {j.daysInStage}d in stage{j.stale ? " · stale" : ""}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
