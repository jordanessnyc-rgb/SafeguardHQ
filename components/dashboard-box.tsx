"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A Today-page summary box: title, count and a one-line preview. Clicking it opens the full list in
 * a dialog. The list itself (`children`) is rendered on the server, so its links and Done forms work
 * as before; after a Done the page refreshes and the open dialog shows the shorter list.
 */
export function DashboardBox({
  title,
  count,
  countLabel,
  preview,
  description,
  tone = "default",
  progress,
  children,
}: {
  title: string;
  count: number;
  /** Replaces the big number's caption, e.g. "3 of 8 done". */
  countLabel?: string;
  preview?: string | null;
  description?: string;
  tone?: "default" | "primary" | "warn";
  /** 0–1: draws a progress bar (setup checklist). */
  progress?: number;
  children: ReactNode;
}) {
  const empty = count === 0;
  const box = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {!empty && <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />}
      </span>
      <span className={cn("block text-2xl font-semibold tabular-nums", tone === "warn" && !empty && "text-amber-700 dark:text-amber-400", empty && "text-muted-foreground")}>
        {count}
      </span>
      {progress !== undefined && (
        <span className="block h-1.5 rounded-full bg-muted" aria-hidden>
          <span className="block h-1.5 rounded-full bg-primary" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      <span className="block truncate text-xs text-muted-foreground">{empty ? "All clear" : (countLabel ?? preview ?? "Click to see all")}</span>
    </>
  );
  const base = "group flex min-h-28 flex-col gap-1.5 rounded-lg border bg-card p-3 text-left";

  if (empty) return <div className={cn(base, "opacity-70")}>{box}</div>;

  return (
    <Dialog>
      <DialogTrigger
        className={cn(
          base,
          "cursor-pointer transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          tone === "primary" && "border-primary/50 bg-sidebar-accent/40",
          tone === "warn" && "border-amber-300 dark:border-amber-800",
        )}
        aria-label={`${title}: ${count}. Show all`}
      >
        {box}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="max-h-[calc(85vh-5rem)] overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
