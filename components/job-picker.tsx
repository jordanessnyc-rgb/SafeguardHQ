"use client";

import { useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type JobOption = { id: string; jobNumber: string; address: string | null };

const text = (j: JobOption) => `${j.jobNumber}${j.address ? ` · ${j.address}` : ""}`;

/**
 * Type-to-search job picker (replaces a <select> of hundreds of jobs). Submits the chosen job's id as
 * `name`. Arrow keys + Enter pick; Escape closes the list. Works without a mouse and on phones.
 */
export function JobPicker({ jobs, name = "jobId", defaultJobId, className }: { jobs: JobOption[]; name?: string; defaultJobId?: string | null; className?: string }) {
  const [selected, setSelected] = useState<JobOption | undefined>(() => jobs.find((j) => j.id === defaultJobId));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return jobs.filter((j) => terms.every((t) => text(j).toLowerCase().includes(t))).slice(0, 8);
  }, [jobs, q]);

  const choose = (j: JobOption | undefined) => {
    setSelected(j);
    setQ("");
    setOpen(false);
  };

  return (
    <div className={cn("relative", className)}>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected && !open ? (
        <div className="flex h-8 items-center gap-1 rounded-lg border border-input bg-background pr-1 pl-2.5 text-sm">
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => (setOpen(true), setTimeout(() => input.current?.focus()))}>
            <span className="font-mono text-xs">{selected.jobNumber}</span>
            {selected.address && <span className="text-muted-foreground"> · {selected.address}</span>}
          </button>
          <button type="button" aria-label="Clear job" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => choose(undefined)}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <input
          ref={input}
          data-job-search
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          aria-label="File under job — type a job number or address"
          placeholder="File under job… (type # or address)"
          value={q}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => (setQ(e.target.value), setActive(0), setOpen(true))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open && matches[active]) {
              e.preventDefault();
              choose(matches[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
        />
      )}
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
          {matches.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching open job.</li>}
          {matches.map((j, i) => (
            <li
              key={j.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), choose(j))}
              onMouseMove={() => setActive(i)}
              className={cn("cursor-pointer truncate rounded-md px-2 py-1.5 text-sm", i === active && "bg-accent")}
            >
              <span className="font-mono text-xs">{j.jobNumber}</span>
              {j.address && <span className="text-muted-foreground"> · {j.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
