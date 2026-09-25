"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Plus, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { groupsFor, NEW_ITEMS } from "@/components/nav-config";
import { quickSearch, type QuickHit } from "@/app/(app)/shell-actions";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "ess:open-command-palette";
const openPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

type Row = { key: string; group: string; title: string; detail?: string | null; href: string; icon?: "new" | "ask" };

/** The sidebar/header search button. Opens the single palette mounted in the app layout. */
export function SearchButton({ className, iconOnly }: { className?: string; iconOnly?: boolean }) {
  const [mac, setMac] = useState(true);
  // Reading the platform during render would mismatch the server HTML; do it after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  if (iconOnly)
    return (
      <Button variant="outline" size="icon-lg" aria-label="Search or jump to" onClick={openPalette} className={className}>
        <Search />
      </Button>
    );
  return (
    <button
      type="button"
      onClick={openPalette}
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground",
        className,
      )}
    >
      <Search className="size-4" aria-hidden />
      <span className="flex-1 text-left">Jump to…</span>
      <kbd className="rounded border px-1 font-mono text-[11px]">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

/**
 * ⌘K / Ctrl+K: jump to any page, create something, or find a job/property/contact/org by typing.
 * Arrow keys move, Enter opens. Record search runs as the signed-in user (RLS applies).
 */
export function CommandPalette({ isOwner }: { isOwner: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<QuickHit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, startSearch] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Debounced record search; a stale response (older request id) is ignored.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      startSearch(async () => {
        const res = await quickSearch(term).catch(() => []);
        if (id === reqId.current) setHits(res);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const rows = useMemo<Row[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (s: string) => !term || s.toLowerCase().includes(term);
    const pages = groupsFor(isOwner)
      .flatMap((g) => g.items.map(({ href, label }) => ({ href, label })))
      .concat({ href: "/settings", label: "Settings" })
      .filter((i) => match(i.label))
      .map((i): Row => ({ key: `p:${i.href}`, group: "Go to", title: i.label, href: i.href }));
    const create = NEW_ITEMS.filter((i) => match(i.label) || (term.length > 0 && "new".startsWith(term))).map(
      (i): Row => ({ key: `n:${i.href}`, group: "Create", title: i.label, href: i.href, icon: "new" }),
    );
    const records = term.length >= 2 ? hits.map((h, i): Row => ({ key: `r:${i}:${h.href}`, group: h.kind, title: h.title, detail: h.detail, href: h.href })) : [];
    const ask = term.length >= 3 ? [{ key: "ask", group: "Ask the CRM", title: `Ask: “${q.trim()}”`, href: `/search?q=${encodeURIComponent(q.trim())}`, icon: "ask" as const }] : [];
    return [...records, ...pages.slice(0, term ? 6 : 8), ...create.slice(0, term ? 3 : 6), ...ask];
  }, [q, hits, isOwner]);

  const go = (row: Row | undefined) => {
    if (!row) return;
    setOpen(false);
    router.push(row.href);
  };

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setQ("");
      setHits([]);
      setActive(0);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastGroup = "";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs" />
        <DialogPrimitive.Popup
          aria-label="Search or jump to"
          className="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100%-2rem))] -translate-x-1/2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10 outline-none"
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
                if (e.target.value.trim().length < 2) setHits([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, rows.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(rows[active]);
                }
              }}
              role="combobox"
              aria-expanded
              aria-controls="command-results"
              aria-activedescendant={rows[active] ? `cmd-${active}` : undefined}
              placeholder="Search jobs, addresses, people, pages…"
              className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            {searching && <span className="text-xs text-muted-foreground">Searching…</span>}
          </div>
          <div ref={listRef} id="command-results" role="listbox" className="max-h-[60vh] overflow-y-auto p-1.5">
            {rows.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No matches.</p>}
            {rows.map((row, i) => {
              const header = row.group !== lastGroup ? row.group : null;
              lastGroup = row.group;
              return (
                <div key={row.key}>
                  {header && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{header}</div>}
                  <div
                    id={`cmd-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(row)}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm", i === active && "bg-accent text-accent-foreground")}
                  >
                    {row.icon === "new" && <Plus className="size-4 text-muted-foreground" aria-hidden />}
                    {row.icon === "ask" && <Sparkles className="size-4 text-primary" aria-hidden />}
                    <span className="truncate font-medium">{row.title}</span>
                    {row.detail && <span className="truncate text-xs text-muted-foreground">{row.detail}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
