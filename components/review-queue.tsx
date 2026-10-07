"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type MessageBox = "review" | "inbox" | "sent" | "archived" | "outbox";

/** The Messages tabs: the review queue, the whole mailbox, and drafts waiting for approval. */
export function QueueTabs({ active, toFile, toApprove }: { active: MessageBox; toFile: number; toApprove: number }) {
  const tab = (key: MessageBox, href: string, label: string, n?: number) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors",
        active === key ? "bg-card font-semibold text-primary shadow-card ring-1 ring-black/[0.05]" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      {label}
      {n !== undefined && <span className={cn("rounded-full px-1.5 text-xs tabular-nums", n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{n}</span>}
    </Link>
  );
  return (
    <nav aria-label="Messages" className="inline-flex flex-wrap gap-0.5 rounded-xl bg-muted p-1">
      {tab("review", "/inbox", "To file", toFile)}
      {tab("inbox", "/inbox?box=inbox", "Inbox")}
      {tab("sent", "/inbox?box=sent", "Sent")}
      {tab("archived", "/inbox?box=archived", "Archived")}
      {tab("outbox", "/outbox", "Drafts & approvals", toApprove)}
    </nav>
  );
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * Keyboard shortcuts for a list of [data-queue-item] cards: J/K next/previous, A accepts the AI
 * suggestion, / jumps to the job search (or the draft's text), ⌘/Ctrl+Enter in a form marked with a
 * [data-approve] child approves it. Letter keys are ignored
 * while typing in a field.
 */
export function QueueKeyboard({ hints }: { hints: { key: string; label: string }[] }) {
  const [pos, setPos] = useState<{ i: number; n: number }>();
  useEffect(() => {
    const items = () => [...document.querySelectorAll<HTMLElement>("[data-queue-item]")];
    const current = () => items().findIndex((el) => el.contains(document.activeElement));
    const focus = (i: number) => {
      const all = items();
      const el = all[Math.max(0, Math.min(i, all.length - 1))];
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const form = (e.target as HTMLElement | null)?.closest?.("form");
        if (form?.querySelector("[data-approve]")) {
          e.preventDefault();
          form.requestSubmit();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const i = current();
      const item = items()[i];
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        focus(e.key === "j" ? i + 1 : Math.max(i - 1, 0));
      } else if (e.key === "a" && item) {
        item.querySelector<HTMLButtonElement>("[data-accept] button")?.click();
      } else if (e.key === "/" && item) {
        const box = item.querySelector<HTMLElement>("[data-job-search], textarea");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      }
    };
    const onFocus = () => setPos({ i: current(), n: items().length });
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return (
    <div className="sticky bottom-16 z-10 mt-4 hidden flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur md:bottom-2 md:flex">
      {hints.map((h) => (
        <span key={h.key}>
          <kbd className="rounded border bg-muted px-1 font-mono">{h.key}</kbd> {h.label}
        </span>
      ))}
      {pos && pos.i >= 0 && (
        <span className="ml-auto tabular-nums">
          {pos.i + 1} of {pos.n}
        </span>
      )}
    </div>
  );
}
