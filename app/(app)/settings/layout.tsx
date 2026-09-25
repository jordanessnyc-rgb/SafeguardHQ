import { Suspense } from "react";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { SettingsNav, type SettingsGroup } from "./settings-nav";

/** Settings shell: a section list beside whichever settings page is open. */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const { cfg, fbConnected } = await user.db(async (tx) => ({
    cfg: (await tx.select().from(s.settings))[0],
    // Owner-only table: RLS returns nothing for a VA, who doesn't see the FreshBooks entry anyway.
    fbConnected: isOwner && (await tx.select({ id: s.freshbooksConnection.id }).from(s.freshbooksConnection)).length > 0,
  }));
  const on = (v: boolean | undefined, yes = "On", no = "Off") => ({ tone: v ? ("ok" as const) : ("off" as const), text: v ? yes : no });
  const autoSends = [cfg?.autoSendEmail, cfg?.autoSendSms, cfg?.autoCreateInvoice].filter(Boolean).length;
  const sec = (key: string) => `/settings?section=${key}`;

  const groups: SettingsGroup[] = [
    { label: "Company", items: [{ href: sec("hours"), label: "Business hours" }, { href: sec("team"), label: "Team & roles" }] },
    {
      label: "Automation",
      items: [
        { href: sec("approvals"), label: "Approvals & auto-send", status: autoSends ? { tone: "warn", text: `${autoSends} auto` } : { tone: "ok", text: "Review all" } },
        { href: sec("digest"), label: "Daily digest", status: on(cfg?.digestEnabled) },
        { href: sec("pipeline"), label: "Pipeline timing" },
        { href: sec("checklist"), label: "AIRnyc checklist" },
      ],
    },
    { label: "Privacy", items: [{ href: sec("airnyc"), label: "AIRnyc & AI", status: cfg?.airnycAiAllowed ? { tone: "warn", text: "AI allowed" } : { tone: "off", text: "AI blocked" } }] },
    {
      label: "Connections",
      items: [
        { href: "/settings/communications", label: "Phone, email & AI" },
        ...(isOwner ? [{ href: "/settings/freshbooks", label: "FreshBooks", status: fbConnected ? { tone: "ok" as const, text: "Connected" } : { tone: "warn" as const, text: "Not connected" } }] : []),
        { href: sec("drive"), label: "Google Drive", status: on(Boolean(cfg?.driveJobsParentFolderId), "Set", "Not set") },
        ...(isOwner && process.env.DOCUSIGN_INTEGRATION_KEY ? [{ href: "/api/docusign/consent", label: "DocuSign consent", external: true }] : []),
        { href: "/settings/claude", label: "Claude access" },
      ],
    },
    ...(isOwner ? [{ label: "Owner only", items: [{ href: "/settings/pricing", label: "Pricing" }, { href: sec("budget"), label: "AI budget" }] }] : []),
  ];

  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-8">
      <Suspense>
        <SettingsNav groups={groups} />
      </Suspense>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
