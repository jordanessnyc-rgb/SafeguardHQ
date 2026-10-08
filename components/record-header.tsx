import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of a record page (job, property, person, company): an icon tile, the name, a code in
 * mono, a row of chips for the facts that identify it, and the actions. Same shape everywhere so
 * records feel like one family.
 */
export function RecordHeader({ icon, eyebrow, title, code, chips, actions, className }: { icon: ReactNode; eyebrow?: ReactNode; title: ReactNode; code?: ReactNode; chips?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("mb-6", className)}>
      {eyebrow}
      <div className="flex flex-wrap items-start gap-4">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15 [&_svg]:size-6">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[1.65rem] leading-tight font-semibold tracking-tight">
            <span className="min-w-0">{title}</span>
            {code && <span className="font-mono text-sm font-normal text-muted-foreground">{code}</span>}
          </h1>
          {chips && <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center justify-end gap-2 sm:pt-1">{actions}</div>}
      </div>
    </header>
  );
}

/** A small fact chip for the header row: optional label, then the value (a link when `href` is given). */
export function MetaChip({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-card px-2.5 text-xs text-foreground/85 shadow-xs ring-1 ring-black/[0.06] dark:ring-white/10 [&_a:hover]:underline", className)}>
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Label-over-value facts, laid out in a responsive grid (the "Overview" look). */
export function FactGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3", className)}>{children}</dl>;
}

export function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm">{children ?? "—"}</dd>
      {hint && <dd className="truncate text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
