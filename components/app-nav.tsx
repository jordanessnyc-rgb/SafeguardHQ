"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { ClipboardList, Home, Inbox, LogOut, Menu, Plus, Route, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SearchButton } from "@/components/command-palette";
import { cn } from "@/lib/utils";
import { groupsFor, NEW_ITEMS, type NavCounts } from "@/components/nav-config";

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

function CountBadge({ n, urgent }: { n: number; urgent?: boolean }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        "ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums",
        urgent ? "bg-primary text-primary-foreground" : "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

function NavLinks({ isOwner, counts, onNavigate }: { isOwner: boolean; counts: NavCounts; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-3">
      {groupsFor(isOwner).map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{g.label}</div>
          {g.items.map(({ href, label, icon: Icon, count, urgent }) => {
            const active = isActive(path, href);
            const n = count ? counts[count] : 0;
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={n ? `${label}, ${n} waiting` : undefined}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  active && "bg-sidebar-accent font-medium text-sidebar-primary",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
                <CountBadge n={n} urgent={urgent} />
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function NewMenu({ className, iconOnly }: { className?: string; iconOnly?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size={iconOnly ? "icon-lg" : "lg"} className={className} aria-label="Create new" />}>
        <Plus />
        {!iconOnly && "New"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {NEW_ITEMS.map((i) => (
          <DropdownMenuItem key={i.href} render={<Link href={i.href} />}>
            {i.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Identity({ name, role }: { name: string; role: string }) {
  const path = usePathname();
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div className="flex items-center gap-2.5 border-t pt-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-(--brand-sage) text-xs font-semibold text-white">
        {initials}
      </span>
      <div className="min-w-0 flex-1 text-xs">
        <div className="truncate font-medium text-foreground">{name}</div>
        <div className="text-muted-foreground">{role}</div>
      </div>
      <Link
        href="/settings"
        aria-label="Settings"
        aria-current={path.startsWith("/settings") ? "page" : undefined}
        className={cn("flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground", path.startsWith("/settings") && "bg-sidebar-accent text-sidebar-primary")}
      >
        <Settings className="size-4" />
      </Link>
      <form action="/auth/signout" method="post">
        <button aria-label="Sign out" className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
          <LogOut className="size-4" />
        </button>
      </form>
    </div>
  );
}

/** Desktop sidebar: brand, ⌘K search, + New, grouped links with live counts, and the signed-in person. */
export function SideNav({ isOwner, counts, name, role }: { isOwner: boolean; counts: NavCounts; name: string; role: string }) {
  return (
    <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar p-3 md:flex">
      <Link href="/" className="flex items-center gap-2.5 px-1.5 pt-1">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-primary text-[11px] font-bold tracking-wide text-primary-foreground">ESS</span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold">ESS CRM</span>
          <span className="block text-[11px] text-muted-foreground">Environmental Safeguard</span>
        </span>
      </Link>
      <div className="flex gap-1.5">
        <SearchButton className="flex-1" />
        <NewMenu iconOnly />
      </div>
      <div className="flex-1">
        <NavLinks isOwner={isOwner} counts={counts} />
      </div>
      <Identity name={name} role={role} />
    </aside>
  );
}

const TABS = [
  { href: "/", label: "Today", icon: Home },
  { href: "/jobs", label: "Jobs", icon: ClipboardList },
  { href: "/route", label: "Route", icon: Route },
  { href: "/inbox", label: "Queue", icon: Inbox, also: ["/outbox"] },
];

/** Phone layout: a slim top bar plus a bottom tab bar; everything else lives under "More". */
export function MobileNav({ isOwner, counts, name, role }: { isOwner: boolean; counts: NavCounts; name: string; role: string }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const queue = counts.inbox + counts.outbox;
  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-sidebar/95 px-4 py-2 backdrop-blur md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <span aria-hidden className="flex size-7 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">ESS</span>
          <span className="text-sm font-semibold">ESS CRM</span>
        </Link>
        <div className="ml-auto flex gap-1.5">
          <SearchButton iconOnly />
          <NewMenu iconOnly />
        </div>
      </header>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {TABS.map(({ href, label, icon: Icon, also }) => {
          const active = isActive(path, href) || also?.some((a) => isActive(path, a));
          const n = href === "/inbox" ? queue : 0;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={n ? `${label}, ${n} waiting` : undefined}
              className={cn("relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px]", active ? "font-semibold text-primary" : "text-muted-foreground")}
            >
              <Icon className="size-5" aria-hidden />
              {label}
              {n > 0 && (
                <span className="absolute top-1.5 left-1/2 ml-1.5 min-w-4.5 rounded-full bg-primary px-1 text-center text-[10px] leading-4.5 font-bold text-primary-foreground">
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </Link>
          );
        })}
        <button type="button" onClick={() => setMore(true)} className="flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground">
          <Menu className="size-5" aria-hidden />
          More
        </button>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="left" className="w-72 gap-3 overflow-y-auto bg-sidebar p-3">
          <SheetHeader className="p-1">
            <SheetTitle>ESS CRM</SheetTitle>
          </SheetHeader>
          <NavLinks isOwner={isOwner} counts={counts} onNavigate={() => setMore(false)} />
          <Identity name={name} role={role} />
        </SheetContent>
      </Sheet>
    </>
  );
}
