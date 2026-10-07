"use client";

import Image from "next/image";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { CalendarDays, ClipboardList, Home, Inbox, KeyRound, LogOut, Menu, Plus, Settings } from "lucide-react";
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

function NavLinks({ isOwner, ai, counts, onNavigate }: { isOwner: boolean; ai: boolean; counts: NavCounts; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-3">
      {groupsFor(isOwner, ai).map((g) => {
        const links = (
        <div key={g.label} className="flex flex-col gap-0.5">
          {!g.secondary && <div className="px-2.5 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground/80 uppercase">{g.label}</div>}
          {g.items.map(({ href, label, icon: Icon, count, urgent }) => {
            const active = isActive(path, href) || (href === "/properties" && ["/contacts", "/organizations"].some((p) => isActive(path, p))) || (href === "/inbox" && isActive(path, "/outbox"));
            const n = href === "/inbox" ? counts.inbox + counts.outbox : count ? counts[count] : 0;
            return (
              <Link
                key={href}
                href={href === "/inbox" && !counts.inbox && counts.outbox > 0 ? "/outbox" : href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={n ? `${label}, ${n} waiting` : undefined}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
                  active && "bg-card text-sidebar-primary shadow-card ring-1 ring-black/[0.05] hover:bg-card dark:ring-white/10",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "text-sidebar-foreground/55")} aria-hidden />
                <span className="truncate">{label}</span>
                <CountBadge n={n} urgent={urgent} />
              </Link>
            );
          })}
        </div>
        );
        return g.secondary ? (
          <details key={`${g.label}-${path}`} open={g.items.some((i) => isActive(path, i.href)) || undefined} className="group">
            <summary className="cursor-pointer rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/70">{g.label}</summary>
            {links}
          </details>
        ) : links;
      })}
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
    <div className="flex items-center gap-2.5 border-t border-sidebar-border pt-3">
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
      <Link
        href="/account/password"
        aria-label="Change password"
        title="Change password"
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <KeyRound className="size-4" />
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
export function SideNav({ isOwner, ai, counts, name, role }: { isOwner: boolean; ai: boolean; counts: NavCounts; name: string; role: string }) {
  return (
    <aside className="sticky top-0 hidden h-svh w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-sidebar-border bg-sidebar p-4 md:flex">
      <Link href="/" className="flex items-center gap-3 px-1 pt-1">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-card shadow-card ring-1 ring-black/[0.05]">
          <Image src="/ess-mark.png" alt="" width={32} height={32} priority className="size-8" />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold">ESS CRM</span>
          <span className="block text-[11px] text-muted-foreground">Environmental Safeguard Solutions</span>
        </span>
      </Link>
      <div className="flex gap-1.5">
        <SearchButton className="flex-1" />
        <NewMenu iconOnly />
      </div>
      <div className="flex-1">
        <NavLinks isOwner={isOwner} ai={ai} counts={counts} />
      </div>
      <Identity name={name} role={role} />
    </aside>
  );
}

const TABS = [
  { href: "/", label: "Today", icon: Home },
  { href: "/jobs", label: "Jobs", icon: ClipboardList },
  { href: "/schedule", label: "Calendar", icon: CalendarDays },
  { href: "/inbox", label: "Messages", icon: Inbox, also: ["/outbox"] },
];

/** Phone layout: a slim top bar plus a bottom tab bar; everything else lives under "More". */
export function MobileNav({ isOwner, ai, counts, name, role }: { isOwner: boolean; ai: boolean; counts: NavCounts; name: string; role: string }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const queue = counts.inbox + counts.outbox;
  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-sidebar/95 px-4 py-2 backdrop-blur md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/ess-mark.png" alt="" width={28} height={28} priority className="size-7 shrink-0" />
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
              href={href === "/inbox" && !counts.inbox && counts.outbox > 0 ? "/outbox" : href}
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
            <SheetTitle className="flex items-center gap-2">
              <Image src="/ess-mark.png" alt="" width={28} height={28} className="size-7" /> ESS CRM
            </SheetTitle>
          </SheetHeader>
          <NavLinks isOwner={isOwner} ai={ai} counts={counts} onNavigate={() => setMore(false)} />
          <Identity name={name} role={role} />
        </SheetContent>
      </Sheet>
    </>
  );
}
