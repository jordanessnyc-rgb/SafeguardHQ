"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type PickOption = { id: string; label: string; detail?: string | null };

const MAX = 30;

/**
 * Type-to-search picker that replaces a long <select>. Submits the chosen id as `name`. Arrow keys and
 * Enter pick, Escape closes. `preferred` ids are listed first under `preferredLabel` (e.g. the chosen
 * company's people). `onAddNew` adds a "+ Add …" row that hands over what was typed.
 * Controlled with `value`/`onChange`, or uncontrolled with `defaultValue`.
 */
export function SearchSelect({
  name,
  id,
  "aria-describedby": describedBy,
  options,
  value,
  defaultValue,
  onChange,
  placeholder = "Type to search…",
  label,
  noun = "results",
  preferred,
  preferredLabel,
  onAddNew,
  addNewLabel = "Add new",
  className,
}: {
  name: string;
  id?: string;
  "aria-describedby"?: string;
  options: PickOption[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (option: PickOption | undefined) => void;
  placeholder?: string;
  label: string;
  noun?: string;
  preferred?: Set<string>;
  preferredLabel?: string;
  onAddNew?: (typed: string) => void;
  addNewLabel?: string;
  className?: string;
}) {
  const [inner, setInner] = useState<string | null>(defaultValue ?? null);
  const selectedId = value !== undefined ? value : inner;
  const selected = useMemo(() => options.find((o) => o.id === selectedId), [options, selectedId]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const { top, rest } = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (o: PickOption) => terms.every((t) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(t));
    const all = options.filter(hit);
    const top = preferred?.size ? all.filter((o) => preferred.has(o.id)) : [];
    const rest = preferred?.size ? all.filter((o) => !preferred.has(o.id)) : all;
    return { top: top.slice(0, MAX), rest: rest.slice(0, Math.max(0, MAX - top.length)) };
  }, [options, q, preferred]);
  const rows: ({ kind: "option"; o: PickOption } | { kind: "add" })[] = [...top.map((o) => ({ kind: "option" as const, o })), ...rest.map((o) => ({ kind: "option" as const, o })), ...(onAddNew ? [{ kind: "add" as const }] : [])];

  const choose = (o: PickOption | undefined) => {
    setInner(o?.id ?? null);
    onChange?.(o);
    setQ("");
    setOpen(false);
  };
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "add") {
      setOpen(false);
      onAddNew?.(q.trim());
      setQ("");
    } else choose(r.o);
  };

  const optionRow = (o: PickOption, i: number) => (
    <li
      key={o.id}
      id={`${listId}-${i}`}
      role="option"
      aria-selected={i === active}
      onMouseDown={(e) => (e.preventDefault(), pick(i))}
      onMouseMove={() => setActive(i)}
      className={cn("cursor-pointer rounded-md px-2 py-1.5 text-sm", i === active && "bg-accent")}
    >
      <span className="block truncate">{o.label}</span>
      {o.detail && <span className="block truncate text-xs text-muted-foreground">{o.detail}</span>}
    </li>
  );

  return (
    <div className={cn("relative", className)}>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected && !open ? (
        <div className="flex min-h-8 items-center gap-1 rounded-lg border border-input bg-background pr-1 pl-2.5 text-sm">
          <button id={id} aria-describedby={describedBy} type="button" aria-label={`${label}: ${selected.label}. Change`} className="min-w-0 flex-1 truncate py-1 text-left" onClick={() => (setOpen(true), setTimeout(() => input.current?.focus()))}>
            {selected.label}
            {selected.detail && <span className="text-muted-foreground"> · {selected.detail}</span>}
          </button>
          <button type="button" aria-label={`Clear ${label.toLowerCase()}`} className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => choose(undefined)}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <input
          ref={input}
          id={id}
          aria-describedby={describedBy}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
          aria-label={label}
          placeholder={placeholder}
          value={q}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => (setQ(e.target.value), setActive(0), setOpen(true))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              // Never submit the surrounding form from the search box.
              e.preventDefault();
              if (open) pick(active);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
        />
      )}
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
          {top.length > 0 && preferredLabel && <li role="presentation" className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{preferredLabel}</li>}
          {top.map((o, i) => optionRow(o, i))}
          {top.length > 0 && rest.length > 0 && <li role="presentation" className="px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Everyone else</li>}
          {rest.map((o, i) => optionRow(o, top.length + i))}
          {top.length + rest.length === 0 && <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">No matching {noun}.</li>}
          {onAddNew && (
            <li
              id={`${listId}-${rows.length - 1}`}
              role="option"
              aria-selected={active === rows.length - 1}
              onMouseDown={(e) => (e.preventDefault(), pick(rows.length - 1))}
              onMouseMove={() => setActive(rows.length - 1)}
              className={cn("mt-1 flex cursor-pointer items-center gap-1.5 rounded-md border-t px-2 py-1.5 text-sm font-medium text-primary", active === rows.length - 1 && "bg-accent")}
            >
              <Plus className="size-3.5" />
              {addNewLabel}
              {q.trim() && <span className="truncate font-normal">“{q.trim()}”</span>}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
