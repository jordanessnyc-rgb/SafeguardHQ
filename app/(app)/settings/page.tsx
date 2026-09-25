import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { SaveBar, SwitchRow } from "@/components/settings-controls";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { loadPipelines } from "@/lib/pipeline/config";
import { titleCase } from "@/lib/labels";
import { isSettingsSection } from "@/lib/settings/form";
import { RoleFields } from "./role-fields";
import { addChecklistItem, inviteUser, saveSettings, saveStaleDays, setChecklistItemActive, setUserRole } from "./actions";

export const metadata = { title: "Settings" };

const ROLE_OPTIONS = [
  { value: "", label: "No access" },
  { value: "OWNER", label: "Owner" },
  { value: "VA", label: "VA" },
  { value: "FIELD", label: "Field (later)" },
  { value: "SUB", label: "Sub (portal)" },
];
const INVITE_ROLES = [
  { value: "VA", label: "VA" },
  { value: "OWNER", label: "Owner" },
  { value: "SUB", label: "Sub (portal)" },
];

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

const PAGE_SECTIONS = ["approvals", "digest", "airnyc", "drive", "budget", "hours", "team", "pipeline", "checklist"] as const;
type PageSection = (typeof PAGE_SECTIONS)[number];
const OWNER_ONLY: PageSection[] = ["budget"];

const TITLES: Record<PageSection, [string, string]> = {
  approvals: ["Approvals & auto-send", "Nothing reaches a client unless you turn it on here. With a switch off, drafts wait in the Review queue for a person."],
  digest: ["Daily digest", "A weekday summary of stale jobs, lab results waiting, unpaid invoices and going-cold leads. Internal only."],
  airnyc: ["AIRnyc & AI", "AIRnyc members' data is sensitive. These settings decide whether the AI may read it and how cases arrive."],
  drive: ["Google Drive", "Where job and AIRnyc case folders are created."],
  budget: ["AI budget", "A monthly ceiling on AI spend. AI features pause when it's reached."],
  hours: ["Business hours", "New York time. Used for missed-call text-backs and response-time targets."],
  team: ["Team & roles", "Invite-only. VAs never see prices, invoices or sub rates; subs only see their own portal."],
  pipeline: ["Pipeline timing", "Jobs idle longer than this in a stage are flagged stale and appear on the dashboard and in the digest."],
  checklist: ["AIRnyc upload checklist", "Files each case needs before upload. File-name tokens: {CASE_ID}, {LAST_NAME}, {DATE}."],
};

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const sp = await searchParams;
  const requested = PAGE_SECTIONS.find((k) => k === sp.section) ?? "approvals";
  const section: PageSection = OWNER_ONLY.includes(requested) && !isOwner ? "approvals" : requested;

  const { cfg, pipelines, team, checklist, subOrgs } = await user.db(async (tx) => ({
    cfg: (await tx.select().from(s.settings))[0],
    pipelines: section === "pipeline" || section === "checklist" ? await loadPipelines(tx) : [],
    team: section === "team" ? await tx.select().from(s.profiles).orderBy(asc(s.profiles.email)) : [],
    checklist: section === "checklist" ? await tx.select().from(s.airnycChecklistItems).orderBy(asc(s.airnycChecklistItems.stage), asc(s.airnycChecklistItems.position)) : [],
    subOrgs:
      section === "team"
        ? await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.type, "SUBCONTRACTOR")).orderBy(asc(s.organizations.name))
        : [],
  }));
  const [title, description] = TITLES[section];

  // One settings section = one form that only writes that section's columns (lib/settings/form.ts).
  const sectionForm = (children: React.ReactNode) =>
    isSettingsSection(section) ? (
      <ActionForm action={saveSettings} className="space-y-4">
        <input type="hidden" name="section" value={section} />
        <fieldset disabled={!isOwner} className="space-y-4">
          {children}
        </fieldset>
        {isOwner && <SaveBar />}
      </ActionForm>
    ) : null;

  return (
    <div className="max-w-3xl">
      <PageHeader title={title} description={<>{description}{!isOwner && <span className="mt-1 block font-medium text-foreground">Read-only — only the owner can change settings.</span>}</>} />

      {section === "approvals" &&
        sectionForm(
          <>
            <Card className="py-0">
              <CardContent className="divide-y">
                <SwitchRow name="autoSendEmail" label="Auto-send emails" risky defaultChecked={cfg.autoSendEmail} disabled={!isOwner} hint="Off: AI and template emails wait in the Review queue for approval." />
                <SwitchRow name="autoSendSms" label="Auto-send texts" risky defaultChecked={cfg.autoSendSms} disabled={!isOwner} hint="Off: missed-call text-backs and drafted replies wait for approval." />
                <SwitchRow
                  name="autoCreateInvoice"
                  label="Auto-send FreshBooks invoices"
                  risky
                  defaultChecked={cfg.autoCreateInvoice}
                  disabled={!isOwner}
                  hint="A draft invoice is always created when a job is marked Delivered. On: it's also emailed to the client right away."
                />
                <SwitchRow name="holdReportUntilPaidDefault" label="Hold reports until paid" defaultChecked={cfg.holdReportUntilPaidDefault} disabled={!isOwner} hint="Default for new jobs. A client or a job can override it." />
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <Field label="Invoice payment terms" hint="Sets the due date on new FreshBooks drafts. Also used for A/R aging when an invoice has no due date.">
                  <span className="flex items-center gap-2 text-sm">
                    <Input name="invoicePaymentTermsDays" inputMode="numeric" className="w-20" defaultValue={cfg.invoicePaymentTermsDays} aria-label="Payment terms in days" />
                    days after the invoice date
                  </span>
                </Field>
              </CardContent>
            </Card>
          </>,
        )}

      {section === "digest" &&
        sectionForm(
          <Card>
            <CardContent className="space-y-4">
              <div className="divide-y">
                <SwitchRow name="digestEnabled" label="Send the daily digest (weekdays)" defaultChecked={cfg.digestEnabled} disabled={!isOwner} hint="Stale jobs, lab results waiting, unpaid invoices, going-cold leads." />
                <SwitchRow name="digestSmsEnabled" label="Also text a one-line summary" defaultChecked={cfg.digestSmsEnabled} disabled={!isOwner} hint={<>Goes to the alert number set under <Link href="/settings/communications" className="underline">Phone, email &amp; AI</Link>.</>} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Send to" className="sm:col-span-2" hint="Email addresses, separated by commas.">
                  <Input name="digestRecipients" defaultValue={cfg.digestRecipients.join(", ")} />
                </Field>
                <Field label="Time">
                  <Input name="digestTime" type="time" defaultValue={cfg.digestTime.slice(0, 5)} />
                </Field>
              </div>
            </CardContent>
          </Card>,
        )}

      {section === "airnyc" &&
        sectionForm(
          <Card>
            <CardContent className="space-y-4">
              <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
                <p>Leave AI access <strong>off</strong> until AIRnyc confirms its data-handling terms in writing. While off, AI calls on AIRnyc data are blocked and logged, and those messages go to the Review queue for a person to read.</p>
              </div>
              <SwitchRow name="airnycAiAllowed" label="Allow the AI to read AIRnyc-linked text (redacted)" defaultChecked={cfg.airnycAiAllowed} disabled={!isOwner} />
              <Field label="How AIRnyc cases arrive">
                <NativeSelect name="airnycMode" defaultValue={cfg.airnycMode === "MANUAL" || cfg.airnycMode === "EMAIL" ? cfg.airnycMode : "MANUAL"} className="max-w-md">
                  <option value="MANUAL">Manual (VA enters cases)</option>
                  <option value="EMAIL" disabled>Email parsing — not built yet (waiting on AIRnyc)</option>
                  <option value="POWER_AUTOMATE" disabled>Power Automate — needs AIRnyc written approval</option>
                  <option value="GRAPH" disabled>Microsoft Graph — needs AIRnyc written approval</option>
                </NativeSelect>
              </Field>
            </CardContent>
          </Card>,
        )}

      {section === "drive" &&
        sectionForm(
          <Card>
            <CardContent className="space-y-4">
              <Field label="Jobs parent folder" hint="Paste the folder's link or ID. A folder for each job is created inside it.">
                <Input name="driveJobsParentFolderId" defaultValue={cfg.driveJobsParentFolderId ?? ""} />
              </Field>
              <Field label="AIRnyc parent folder">
                <Input name="driveAirnycParentFolderId" defaultValue={cfg.driveAirnycParentFolderId ?? ""} />
              </Field>
              <Field label="Folder template" hint="Its sub-folders and files are copied into every new job or case folder.">
                <Input name="driveTemplateFolderId" defaultValue={cfg.driveTemplateFolderId ?? ""} />
              </Field>
            </CardContent>
          </Card>,
        )}

      {section === "budget" &&
        sectionForm(
          <Card>
            <CardContent>
              <Field label="Monthly AI spending cap (USD)" hint={<>Spend so far this month is on <Link href="/settings/communications" className="underline">Phone, email &amp; AI</Link>. Leave blank for no cap.</>}>
                <Input name="aiMonthlyCostCapUsd" inputMode="decimal" className="w-32" defaultValue={cfg.aiMonthlyCostCapUsd ?? ""} />
              </Field>
            </CardContent>
          </Card>,
        )}

      {section === "hours" &&
        sectionForm(
          <Card>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">Leave both times blank for a day you&apos;re closed.</p>
              <div className="grid gap-1.5">
                {DAYS.map(([d, name]) => (
                  <div key={d} className="flex items-center gap-2 text-sm">
                    <span className="w-24">{name}</span>
                    <Input name={`${d}Open`} type="time" className="w-28" defaultValue={cfg.businessHours[d]?.open ?? ""} aria-label={`${name} open`} />
                    <span aria-hidden>–</span>
                    <Input name={`${d}Close`} type="time" className="w-28" defaultValue={cfg.businessHours[d]?.close ?? ""} aria-label={`${name} close`} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>,
        )}

      {section === "team" && (
        <Card>
          <CardContent className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {team.map((p) => (
                  <TableRow key={p.userId}>
                    <TableCell>
                      <div>{p.fullName ?? p.email}</div>
                      {p.fullName && <div className="text-xs text-muted-foreground">{p.email}</div>}
                    </TableCell>
                    <TableCell>
                      {isOwner ? (
                        <ActionForm action={setUserRole.bind(null, p.userId)} className="flex flex-wrap items-center gap-1">
                          <RoleFields roles={ROLE_OPTIONS} subOrgs={subOrgs} defaultRole={p.role ?? ""} defaultOrgId={p.orgId} compact />
                          <Button size="xs" variant="outline" type="submit">Save</Button>
                        </ActionForm>
                      ) : (
                        <Badge variant="secondary">{p.role ? titleCase(p.role) : "No access"}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {isOwner && (
              <div className="border-t pt-3">
                <div className="mb-2 text-sm font-medium">Invite someone</div>
                <ActionForm action={inviteUser} className="grid gap-2 sm:grid-cols-4">
                  <Input name="email" type="email" placeholder="Email" required className="sm:col-span-2" aria-label="Email" />
                  <Input name="fullName" placeholder="Name" aria-label="Name" />
                  <RoleFields roles={INVITE_ROLES} subOrgs={subOrgs} defaultRole="VA" />
                  <SubmitButton size="sm">Send invite</SubmitButton>
                </ActionForm>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {section === "pipeline" && (
        <Card>
          <CardContent>
            <ActionForm action={saveStaleDays} className="space-y-4">
              <fieldset disabled={!isOwner} className="space-y-5">
                {pipelines.map((p) => (
                  <div key={p.key}>
                    <div className="mb-2 text-sm font-medium">{p.name}</div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                      {p.stages
                        .filter((st) => !st.isTerminal)
                        .map((st) => (
                          <label key={st.key} className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate">{st.name}</span>
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Input name={`stale:${p.key}:${st.key}`} defaultValue={st.staleAfterDays ?? ""} inputMode="numeric" className="h-7 w-14 text-sm" aria-label={`${st.name}: stale after how many days`} />
                              days
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                ))}
              </fieldset>
              {isOwner && <SaveBar label="Save timings" />}
            </ActionForm>
          </CardContent>
        </Card>
      )}

      {section === "checklist" && (
        <Card>
          <CardHeader>
            <CardTitle>Checklist items</CardTitle>
            <CardDescription>Defaults are placeholders — confirm AIRnyc&apos;s naming.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {checklist.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 text-sm">
                <span className={i.active ? "" : "text-muted-foreground line-through"}>
                  <Badge variant="outline">{titleCase(i.stage)}</Badge> {i.label} <code className="text-xs">{i.fileNamePattern}</code>
                </span>
                {isOwner && (
                  <form action={setChecklistItemActive.bind(null, i.id, !i.active)}>
                    <Button size="xs" variant="ghost" type="submit">{i.active ? "Disable" : "Enable"}</Button>
                  </form>
                )}
              </div>
            ))}
            {isOwner && (
              <ActionForm action={addChecklistItem} className="grid gap-2 border-t pt-3 sm:grid-cols-2">
                <NativeSelect name="stage" aria-label="Stage">
                  {(pipelines.find((p) => p.key === "AIRNYC")?.stages ?? []).map((st) => <option key={st.key} value={st.key}>{st.name}</option>)}
                </NativeSelect>
                <Input name="label" placeholder="Item (e.g. Signed work order)" required aria-label="Item" />
                <Input name="fileNamePattern" placeholder="{CASE_ID}_Work_Order.pdf" aria-label="File name pattern" />
                <SubmitButton size="sm" variant="secondary">Add item</SubmitButton>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
