import {
  Activity,
  BarChart3,
  Building2,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Gavel,
  HeartPulse,
  Home,
  Inbox,
  Landmark,
  Megaphone,
  Route,
  Send,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavCounts = { tasks: number; inbox: number; outbox: number };
type CountKey = keyof NavCounts;
export type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean; count?: CountKey; urgent?: boolean };

/** Grouped by what the person is doing, with the queues that wait on someone kept together near the top. */
export const NAV_GROUPS: { label: string; ownerOnly?: boolean; items: NavItem[] }[] = [
  {
    label: "Today",
    items: [
      { href: "/", label: "Dashboard", icon: Home },
      { href: "/tasks", label: "Tasks", icon: CheckSquare, count: "tasks" },
      { href: "/route", label: "Route", icon: Route },
    ],
  },
  {
    label: "Queues",
    items: [
      { href: "/inbox", label: "Inbox review", icon: Inbox, count: "inbox", urgent: true },
      { href: "/outbox", label: "Outbox", icon: Send, count: "outbox", urgent: true },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/jobs", label: "Jobs", icon: ClipboardList },
      { href: "/compliance", label: "Compliance", icon: CalendarClock },
      { href: "/airnyc", label: "AIRnyc", icon: HeartPulse },
      { href: "/bids", label: "Bids", icon: Gavel },
    ],
  },
  {
    label: "Records",
    items: [
      { href: "/properties", label: "Properties", icon: Building2 },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/organizations", label: "Organizations", icon: Landmark },
    ],
  },
  {
    label: "Grow",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/search", label: "Ask the CRM", icon: Sparkles },
    ],
  },
  {
    label: "Owner",
    ownerOnly: true,
    items: [
      { href: "/reports", label: "Reports", icon: BarChart3, ownerOnly: true },
      { href: "/admin", label: "System health", icon: Activity, ownerOnly: true },
    ],
  },
];

export const NEW_ITEMS = [
  { href: "/jobs/new", label: "New job" },
  { href: "/properties/new", label: "New property" },
  { href: "/contacts/new", label: "New contact" },
  { href: "/organizations/new", label: "New organization" },
  { href: "/airnyc/new", label: "New AIRnyc case" },
  { href: "/bids/new", label: "New bid" },
];

export const groupsFor = (isOwner: boolean) => NAV_GROUPS.filter((g) => isOwner || !g.ownerOnly);
