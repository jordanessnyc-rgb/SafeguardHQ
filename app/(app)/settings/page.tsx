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
import { PASSWORD_MIN } from "@/lib/auth/password";
import { addChecklistItem, addUser, saveSettings, saveStaleDays, saveTrackerColumns, setChecklistItemActive, setUserPassword, setUserRole, syncAirnycNow } from "./actions";
import { Status } from "@/components/status";
import { fmtDate } from "@/lib/labels";
import { graphFromEnv } from "@/lib/integrations/microsoft-graph";
import { guessColumns, readTracker, TRACKER_FIELDS, type ColumnMap } from "@/lib/airnyc/tracker";

type GraphStatus = { configured: boolean; site: string | null; error: string | null; sheet: string | null; sheets: string[]; headers: string[]; rows: number; columns: ColumnMap };
const EMPTY_GRAPH: GraphStatus = { configured: false, site: null, error: null, sheet: null, sheets: [], headers: [], rows: 0, columns: {} };

/** Reads the tracker's headers live so the owner can map columns; any failure shows as a message, not a broken page. */
async function graphStatus(cfg: { airnycTrackerUrl: string | null; airnycTrackerSheet: string | null; airnycTrackerColumns: Record<string, string> | null }): Promise<GraphStatus> {
  const graph = graphFromEnv();
  if (!graph) return EMPTY_GRAPH;
  const out: GraphStatus = { ...EMPTY_GRAPH, configured: true, columns: (cfg.airnycTrackerColumns ?? {}) as ColumnMap };
  if (!cfg.airnycTrackerUrl) return out;
  try {
    const item = await graph.itemByUrl(cfg.airnycTrackerUrl);
    out.site = new URL(item.webUrl).hostname;
    const sheet = await readTracker(await graph.download(item.driveId, item.id), cfg.airnycTrackerSheet);
    out.sheet = sheet.sheet;
    out.sheets = sheet.sheets;
    out.headers = sheet.headers;
    out.rows = sheet.rows.length;
    if (!cfg.airnycTrackerColumns) out.columns = guessColumns(sheet.headers);
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

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

const PAGE_SECTIONS = ["approvals", "digest", "followups", "airnyc", "drive", "budget", "hours", "team", "pipeline", "checklist"] as const;
type PageSection = (typeof PAGE_SECTIONS)[number];
const OWNER_ONLY: PageSection[] = ["budget"];

const TITLES: Record<PageSection, [string, string]> = {
  approvals: ["Approvals & auto-send", "Nothing reaches a client unless you turn it on here. With a switch off, drafts wait in the Review queue for a person."],
  digest: ["Daily digest", "A weekday summary of stale jobs, lab results waiting, unpaid invoices and going-cold leads. Internal only."],
  followups: ["Proposal follow-ups", "When a proposal gets no reply, a follow-up text or email is drafted in the Outbox and a task reminds you. Drafts wait for your OK unless auto-send is on."],
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
  const graph = section === "airnyc" ? await graphStatus(cfg) : EMPTY_GRAPH;
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

      {section === "followups" &&
        sectionForm(
          <Card>
            <CardContent className="space-y-4">
              <SwitchRow name="followUpEnabled" label="Draft proposal follow-ups" defaultChecked={cfg.followUpEnabled} disabled={!isOwner} hint="Only for jobs in Proposal sent with no call, text or email back from the client since it went out. Never for AIRnyc or do-not-contact." />
              <Field label="Days after the proposal" hint="Comma-separated, up to 4. Default: 3, 7 (a first nudge, then a second one)." className="max-w-xs">
                <Input name="followUpDays" defaultValue={cfg.followUpDays.join(", ")} disabled={!isOwner} />
              </Field>
              <p className="text-sm text-muted-foreground">
                The wording is in the <Link href="/settings/communications" className="underline">Proposal follow-up</Link> templates (text and email) — edit them there.
              </p>
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
                <NativeSelect name="airnycMode" defaultValue={cfg.airnycMode === "GRAPH" ? "GRAPH" : "MANUAL"} className="max-w-md">
                  <option value="MANUAL">Manual (VA enters cases)</option>
                  <option value="GRAPH">Microsoft Graph (read AIRnyc&apos;s tracker and folders on SharePoint)</option>
                </NativeSelect>
              </Field>
              <div className="space-y-4 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  Microsoft / SharePoint
                  {!graph.configured ? <Status tone="off">Not set up on the server</Status> : graph.error ? <Status tone="error">Can&apos;t reach SharePoint</Status> : graph.site ? <Status tone="ok">Connected to {graph.site}</Status> : <Status tone="warn">Add the tracker address</Status>}
                </div>
                {!graph.configured && <p className="text-xs text-muted-foreground">AIRnyc&apos;s IT registers the app and sends three values; they go in the server&apos;s secrets (MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET). The steps and the message to send them are in docs/RUNBOOK.md.</p>}
                {graph.error && <p className="text-xs text-destructive">{graph.error}</p>}
                <Field label="Tracker workbook address" hint="The .xlsx on SharePoint. Open it, then copy the address from the browser bar (not a sharing link).">
                  <Input name="airnycTrackerUrl" type="url" defaultValue={cfg.airnycTrackerUrl ?? ""} placeholder="https://<org>.sharepoint.com/sites/<site>/Shared Documents/ESS/Tracker.xlsx" />
                </Field>
                <Field label="Sheet name" hint="Leave blank for the first sheet.">
                  <Input name="airnycTrackerSheet" defaultValue={cfg.airnycTrackerSheet ?? ""} className="max-w-xs" list="airnyc-sheets" />
                  {graph.sheets.length > 0 && (
                    <datalist id="airnyc-sheets">
                      {graph.sheets.map((n) => <option key={n} value={n} />)}
                    </datalist>
                  )}
                </Field>
                <Field label="Folder that holds the case folders" hint="Each case's folder is found by its case ID in the folder name.">
                  <Input name="airnycRootFolderUrl" type="url" defaultValue={cfg.airnycRootFolderUrl ?? ""} placeholder="https://<org>.sharepoint.com/sites/<site>/Shared Documents/ESS" />
                </Field>
              </div>
            </CardContent>
          </Card>,
        )}
      {section === "airnyc" && graph.configured && graph.headers.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Tracker columns</CardTitle>
            <CardDescription>
              Which column of sheet &ldquo;{graph.sheet}&rdquo; feeds each case field. {graph.rows} rows found. Only the case ID is required; the rest fill the case record.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionForm action={saveTrackerColumns} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(TRACKER_FIELDS) as (keyof typeof TRACKER_FIELDS)[]).map((f) => (
                  <label key={f} className="grid gap-1 text-sm">
                    <span className={f === "caseId" ? "font-medium" : ""}>{TRACKER_FIELDS[f]}</span>
                    <NativeSelect name={`col:${f}`} defaultValue={graph.columns[f] ?? ""} disabled={!isOwner}>
                      <option value="">— not in the tracker —</option>
                      {graph.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </NativeSelect>
                  </label>
                ))}
              </div>
              {isOwner && <SubmitButton size="sm">Save columns</SubmitButton>}
            </ActionForm>
            {isOwner && (
              <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
                {cfg.airnycTrackerColumns?.caseId ? (
                  <ActionForm action={syncAirnycNow}>
                    <SubmitButton size="sm" variant="outline">Sync now</SubmitButton>
                  </ActionForm>
                ) : (
                  <span className="text-xs text-muted-foreground">Save the columns first.</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {cfg.airnycGraphSyncedAt ? `Last sync ${fmtDate(cfg.airnycGraphSyncedAt, true)}${cfg.airnycGraphError ? `: ${cfg.airnycGraphError}` : ""}` : "Not synced yet. The worker syncs every 15 minutes once columns are saved and the mode is Microsoft Graph."}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
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
                  {isOwner && <TableHead>Password</TableHead>}
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
                    {isOwner && (
                      <TableCell>
                        <ActionForm action={setUserPassword.bind(null, p.userId)} className="flex flex-wrap items-center gap-1">
                          <Input name="password" type="text" autoComplete="off" placeholder="New password" minLength={PASSWORD_MIN} required className="h-7 w-36 text-sm" aria-label={`New password for ${p.fullName ?? p.email}`} />
                          <Button size="xs" variant="outline" type="submit">Set</Button>
                        </ActionForm>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {isOwner && (
              <div className="border-t pt-3">
                <div className="mb-1 text-sm font-medium">Add someone</div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Choose a starting password and give it to them. They sign in with their email and that password, and can change it under Password. No email is sent.
                </p>
                <ActionForm action={addUser} className="grid gap-2 sm:grid-cols-4">
                  <Input name="email" type="email" placeholder="Email" required className="sm:col-span-2" aria-label="Email" />
                  <Input name="fullName" placeholder="Name" aria-label="Name" />
                  <Input name="password" type="text" autoComplete="off" placeholder={`Starting password (${PASSWORD_MIN}+ characters)`} minLength={PASSWORD_MIN} required aria-label="Starting password" />
                  <RoleFields roles={INVITE_ROLES} subOrgs={subOrgs} defaultRole="VA" />
                  <SubmitButton size="sm">Add</SubmitButton>
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
