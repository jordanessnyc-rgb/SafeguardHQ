/**
 * Owner's setup checklist on the dashboard (Phase 7a): the things the CRM needs from Jordan before
 * it's fully useful. Each item is checked against live data, so it disappears once done.
 */
import { count, isNull, ne } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { loadTemplate } from "@/lib/docs/render";

export type SetupItem = { key: string; title: string; why: string; done: boolean; href?: string; action?: string };

export async function setupChecklist(tx: Tx): Promise<SetupItem[]> {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [cfg] = await tx.select().from(s.settings);
  const [fb] = await tx.select({ requested: s.freshbooksConnection.historyRequestedAt, status: s.freshbooksConnection.historyStatus }).from(s.freshbooksConnection);
  const pricing = await n(tx.select({ n: count() }).from(s.pricingRules));
  const cycles = await n(tx.select({ n: count() }).from(s.complianceRules).where(isNull(s.complianceRules.archivedAt)));
  const team = await n(tx.select({ n: count() }).from(s.profiles).where(ne(s.profiles.role, "OWNER")));
  const licenses = await n(tx.select({ n: count() }).from(s.credentials).where(isNull(s.credentials.archivedAt)));
  const templates = !loadTemplate("ESS_Proposal").placeholder && !loadTemplate("ESS_Report").placeholder;

  return [
    fb
      ? {
          key: "history",
          title: "Bring in your FreshBooks invoice history",
          why: "Past invoices become past jobs on each building, so clients show their history and reports show real revenue.",
          done: Boolean(fb.status?.finishedAt && !fb.status.error),
          href: "/settings/freshbooks",
          action: fb.requested ? "Check progress" : "Import",
        }
      : { key: "freshbooks", title: "Connect FreshBooks", why: "Invoices, payments and client billing.", done: false, href: "/settings/freshbooks", action: "Connect" },
    { key: "pricing", title: "Enter your prices", why: "The quote builder prices each service from these. Only you can see them.", done: pricing > 0, href: "/settings/pricing", action: "Add prices" },
    {
      key: "cycles",
      title: "Set compliance cycles",
      why: "How often each service repeats (e.g. LL152 gas piping). The CRM reminds you when a building is due again.",
      done: cycles > 0,
      href: "/compliance#rules",
      action: "Add cycles",
    },
    { key: "licenses", title: "Add your licenses", why: "You get a reminder before each one expires.", done: licenses > 0, href: "/compliance#licenses", action: "Add licenses" },
    {
      key: "digest",
      title: "Choose who gets the morning digest",
      why: "A daily summary of what's due, what's stale and what's owed.",
      done: !cfg?.digestEnabled || (cfg.digestRecipients?.length ?? 0) > 0,
      href: "/settings?section=digest",
      action: "Add recipients",
    },
    {
      key: "alerts",
      title: "Add your cell for outage alerts",
      why: "If email or phone syncing stops, you get a text.",
      done: Boolean(cfg?.healthAlertPhone),
      href: "/settings/communications",
      action: "Add number",
    },
    { key: "team", title: "Invite your assistant", why: "VAs can work the inbox, jobs and scheduling — never prices.", done: team > 0, href: "/settings?section=team", action: "Invite" },
    {
      key: "templates",
      title: "Send Claude your Word templates",
      why: "Proposals and reports use a plain placeholder layout until your ESS proposal and report templates are added.",
      done: templates,
    },
  ];
}
