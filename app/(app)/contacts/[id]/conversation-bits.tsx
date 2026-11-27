"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Send } from "lucide-react";
import { cn } from "@/lib/utils";

/** Keeps the conversation scrolled to the newest message when the page opens. */
export function ScrollToNewest({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** A one-line "Type a message…" bar that opens the full compose form (text/email, template, send). */
export function ComposerBar({ children, disabled }: { children: ReactNode; disabled?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (disabled) return <div className="border-t p-3">{disabled}</div>;
  return (
    <div className="border-t">
      {open ? (
        <div className="max-h-[60dvh] space-y-2 overflow-y-auto p-3">
          <button type="button" onClick={() => setOpen(false)} className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground">
            New message
            <ChevronDown className="size-4" aria-hidden />
          </button>
          {children}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn("m-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm text-muted-foreground shadow-xs hover:border-primary/50")}
        >
          <span className="flex-1">Type a message…</span>
          <Send className="size-4 text-primary" aria-hidden />
        </button>
      )}
    </div>
  );
}
