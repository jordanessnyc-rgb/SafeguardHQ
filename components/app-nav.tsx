"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, CalendarClock, CheckSquare, ClipboardList, HeartPulse, Home, Inbox, Landmark, Send, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/jobs", label: "Jobs", icon: ClipboardList },
  { href: "/properties", label: "Properties", icon: Building2 },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/organizations", label: "Organizations", icon: Landmark },
  { href: "/airnyc", label: "AIRnyc", icon: HeartPulse },
  { href: "/inbox", label: "Inbox review", icon: Inbox },
  { href: "/outbox", label: "Outbox", icon: Send },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/compliance", label: "Compliance", icon: CalendarClock },
  { href: "/reports", label: "Reports", icon: BarChart3, ownerOnly: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

const navFor = (isOwner: boolean) => NAV.filter((n) => isOwner || !n.ownerOnly);

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path.startsWith(href));

export function SideNav({ isOwner }: { isOwner: boolean }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {navFor(isOwner).map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            isActive(path, href) && "bg-sidebar-accent font-medium text-sidebar-primary",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function MobileNav({ isOwner }: { isOwner: boolean }) {
  const path = usePathname();
  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2">
      {navFor(isOwner).map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "shrink-0 rounded-full border px-3 py-1 text-xs",
            isActive(path, href) ? "border-primary bg-primary text-primary-foreground" : "bg-background",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
