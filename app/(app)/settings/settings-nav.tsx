"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Status, type StatusTone } from "@/components/status";
import { cn } from "@/lib/utils";

export type SettingsLink = { href: string; label: string; status?: { tone: StatusTone; text: string }; external?: boolean };
export type SettingsGroup = { label: string; items: SettingsLink[] };

/** Settings section list: a column on desktop, a collapsible list (showing the current section) on phones. */
export function SettingsNav({ groups }: { groups: SettingsGroup[] }) {
  const path = usePathname();
  const section = useSearchParams().get("section");
  const here = path === "/settings" ? `/settings?section=${section ?? "approvals"}` : path;
  const current = groups.flatMap((g) => g.items).find((i) => i.href === here);

  const list = (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{g.label}</div>
          {g.items.map((i) => {
            const active = i.href === here;
            const cls = cn(
              "flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1 text-sm hover:bg-muted",
              active && "bg-sidebar-accent font-medium text-sidebar-primary hover:bg-sidebar-accent",
            );
            const inner = (
              <>
                <span className="flex-1">{i.label}</span>
                {i.status && <Status tone={i.status.tone}>{i.status.text}</Status>}
              </>
            );
            // A plain <a> for route handlers that redirect off-site (e.g. DocuSign consent).
            return i.external ? (
              <a key={i.href} href={i.href} className={cls}>{inner}</a>
            ) : (
              <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={cls}>
                {inner}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <>
      <nav aria-label="Settings sections" className="hidden w-56 shrink-0 md:block">
        {list}
      </nav>
      <details className="group rounded-lg border md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium">
          <span>
            <span className="text-muted-foreground">Section: </span>
            {current?.label ?? "Settings"}
          </span>
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <nav aria-label="Settings sections" className="border-t p-2">
          {list}
        </nav>
      </details>
    </>
  );
}
