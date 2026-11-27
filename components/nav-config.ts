import {
  Activity,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  Gavel,
  HeartPulse,
  Home,
  Inbox,
  Landmark,
  Megaphone,
  Route,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavCounts = { tasks: number; inbox: number; outbox: number };
type CountKey = keyof NavCounts;
export type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean; aiOnly?: boolean; count?: CountKey; urgent?: boolean };

/** Daily work first; specialist tools stay available under More tools. */
export const NAV_GROUPS: { label: string; ownerOnly?: boolean; secondary?: boolean; items: NavItem[] }[] = [
  { label: "Daily work", items: [
    { href: "/", label: "Today", icon: Home },
    { href: "/jobs", label: "Jobs", icon: ClipboardList },
    { href: "/properties", label: "Clients & properties", icon: Building2 },
    { href: "/inbox", label: "Messages", icon: Inbox, count: "inbox", urgent: true },
    { href: "/schedule", label: "Calendar", icon: CalendarDays },
  ] },
  { label: "Workspaces", items: [
    { href: "/airnyc", label: "AIRnyc cases", icon: HeartPulse },
    { href: "/bids", label: "Government bids", icon: Gavel },
  ] },
  { label: "More tools", secondary: true, items: [
    { href: "/tasks", label: "All tasks", icon: CheckSquare, count: "tasks" },
    { href: "/route", label: "Daily route", icon: Route },
    { href: "/compliance", label: "Compliance", icon: CalendarClock },
    { href: "/contacts", label: "People", icon: Users },
    { href: "/organizations", label: "Companies", icon: Landmark },
    { href: "/campaigns", label: "Campaigns", icon: Megaphone },
    { href: "/search", label: "Ask the CRM", icon: Sparkles, aiOnly: true },
  ] },
  { label: "Owner tools", secondary: true, ownerOnly: true, items: [
    { href: "/reports", label: "Business analytics", icon: BarChart3, ownerOnly: true },
    { href: "/admin", label: "System health", icon: Activity, ownerOnly: true },
  ] },
];

export const NEW_ITEMS = [
  { href: "/jobs/new", label: "New job" },
  { href: "/properties/new", label: "New property" },
  { href: "/contacts/new", label: "New contact" },
  { href: "/organizations/new", label: "New organization" },
  { href: "/airnyc/new", label: "New AIRnyc case" },
  { href: "/bids/new", label: "New bid" },
];

/** What this person sees: owner-only groups for the owner; AI-only pages only while AI is configured. */
export const groupsFor = (isOwner: boolean, ai: boolean) =>
  NAV_GROUPS.filter((g) => isOwner || !g.ownerOnly)
    .map((g) => ({ ...g, items: g.items.filter((i) => ai || !i.aiOnly) }))
    .filter((g) => g.items.length > 0);
