import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "error" | "off";

const TONE: Record<StatusTone, { dot: string; text: string; word: string }> = {
  ok: { dot: "bg-(--brand-sage)", text: "text-primary", word: "OK" },
  warn: { dot: "bg-amber-500", text: "text-amber-800 dark:text-amber-300", word: "Needs attention" },
  error: { dot: "bg-destructive", text: "text-destructive", word: "Problem" },
  off: { dot: "bg-muted-foreground/50", text: "text-muted-foreground", word: "Off" },
};

/** A coloured dot plus words, so the state is readable without relying on colour or ✓/✗ glyphs. */
export function Status({ tone, children, className }: { tone: StatusTone; children?: ReactNode; className?: string }) {
  const t = TONE[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", t.text, className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", t.dot)} />
      {children ?? t.word}
    </span>
  );
}
