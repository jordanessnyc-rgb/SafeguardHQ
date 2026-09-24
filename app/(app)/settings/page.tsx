import { asc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { loadPipelines } from "@/lib/pipeline/config";
import { titleCase } from "@/lib/labels";
import { addChecklistItem, inviteUser, saveSettings, saveStaleDays, setChecklistItemActive, setUserRole } from "./actions";

export const metadata = { title: "Settings" };

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

export default async function SettingsPage() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const { cfg, pipelines, team, checklist } = await user.db(async (tx) => ({
    cfg: (await tx.select().from(s.settings))[0],
    pipelines: await loadPipelines(tx),
    team: await tx.select().from(s.profiles).orderBy(asc(s.profiles.email)),
    checklist: await tx.select().from(s.airnycChecklistItems).orderBy(asc(s.airnycChecklistItems.stage), asc(s.airnycChecklistItems.position)),
  }));
  const airnycStages = pipelines.find((p) => p.key === "AIRNYC")?.stages ?? [];
  const toggle = (name: keyof typeof cfg, text: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={Boolean(cfg[name])} disabled={!isOwner} className="mt-0.5 size-4 accent-primary" />
      <span>
        {text}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );

  return (
    <>
      <PageHeader title="Settings" description={isOwner ? undefined : "Read-only — only the owner can change settings."} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Automation &amp; data handling</CardTitle>
            <CardDescription>Everything client-facing is draft → human approval unless turned on here.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveSettings} className="space-y-4">
              <fieldset disabled={!isOwner} className="space-y-4">
                <div className="space-y-2">
                  {toggle("autoSendEmail", "Auto-send emails", "Off: AI and template emails stay drafts until approved.")}
                  {toggle("autoSendSms", "Auto-send SMS")}
                  {toggle("autoCreateInvoice", "Auto-send FreshBooks invoices", "Drafts are always created on Delivered (Phase 3); this controls sending.")}
                  {toggle("holdReportUntilPaidDefault", "Hold reports until paid (default for new jobs)")}
                </div>
                <div className="space-y-2 rounded-md border border-amber-300 p-3">
                  {toggle(
                    "airnycAiAllowed",
                    "Allow AIRnyc-linked text to reach the AI layer (redacted)",
                    "Leave OFF until AIRnyc confirms data-handling terms. When off, AI calls on AIRnyc data are blocked and logged.",
                  )}
                  <Field label="AIRnyc connection mode">
                    <NativeSelect name="airnycMode" defaultValue={cfg.airnycMode === "MANUAL" || cfg.airnycMode === "EMAIL" ? cfg.airnycMode : "MANUAL"}>
                      <option value="MANUAL">Manual (VA enters cases)</option>
                      <option value="EMAIL">Email parsing (Phase 2)</option>
                      <option value="POWER_AUTOMATE" disabled>Power Automate — needs AIRnyc written approval</option>
                      <option value="GRAPH" disabled>Microsoft Graph — needs AIRnyc written approval</option>
                    </NativeSelect>
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Daily digest recipients" className="sm:col-span-2" hint="Comma-separated emails.">
                    <Input name="digestRecipients" defaultValue={cfg.digestRecipients.join(", ")} />
                  </Field>
                  <Field label="Digest time">
                    <Input name="digestTime" type="time" defaultValue={cfg.digestTime.slice(0, 5)} />
                  </Field>
                </div>
                <div>
                  <div className="mb-1 text-sm font-medium">Business hours (New York)</div>
                  <p className="mb-2 text-xs text-muted-foreground">Used for missed-call text-back and SLAs. Leave both blank for closed.</p>
                  <div className="grid gap-1">
                    {DAYS.map(([d, name]) => (
                      <div key={d} className="flex items-center gap-2 text-sm">
                        <span className="w-10">{name}</span>
                        <Input name={`${d}Open`} type="time" className="w-28" defaultValue={cfg.businessHours[d]?.open ?? ""} aria-label={`${name} open`} />
                        <span>–</span>
                        <Input name={`${d}Close`} type="time" className="w-28" defaultValue={cfg.businessHours[d]?.close ?? ""} aria-label={`${name} close`} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3">
                  <Field label="Drive: jobs parent folder" hint="Paste the folder URL or ID. Job folders are created inside it.">
                    <Input name="driveJobsParentFolderId" defaultValue={cfg.driveJobsParentFolderId ?? ""} />
                  </Field>
                  <Field label="Drive: AIRnyc parent folder">
                    <Input name="driveAirnycParentFolderId" defaultValue={cfg.driveAirnycParentFolderId ?? ""} />
                  </Field>
                  <Field label="Drive: folder template" hint="Its sub-folders and files are copied into every new job/case folder.">
                    <Input name="driveTemplateFolderId" defaultValue={cfg.driveTemplateFolderId ?? ""} />
                  </Field>
                  <Field label="AI monthly cost cap (USD)">
                    <Input name="aiMonthlyCostCapUsd" inputMode="decimal" className="w-32" defaultValue={cfg.aiMonthlyCostCapUsd ?? ""} />
                  </Field>
                </div>
                {isOwner && <SubmitButton>Save settings</SubmitButton>}
              </fieldset>
            </ActionForm>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Team</CardTitle>
              <CardDescription>Invite-only. VAs never see prices, invoices, or sub rates.</CardDescription>
            </CardHeader>
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
                            <NativeSelect name="role" defaultValue={p.role ?? ""} className="h-7 w-28 text-xs" aria-label="Role">
                              <option value="">No access</option>
                              <option value="OWNER">Owner</option>
                              <option value="VA">VA</option>
                              <option value="FIELD">Field (later)</option>
                              <option value="SUB">Sub (Phase 5)</option>
                            </NativeSelect>
                            <Button size="xs" variant="ghost" type="submit">Set</Button>
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
                <ActionForm action={inviteUser} className="grid gap-2 border-t pt-3 sm:grid-cols-4">
                  <Input name="email" type="email" placeholder="email" required className="sm:col-span-2" />
                  <Input name="fullName" placeholder="Name" />
                  <NativeSelect name="role" defaultValue="VA" aria-label="Role">
                    <option value="VA">VA</option>
                    <option value="OWNER">Owner</option>
                  </NativeSelect>
                  <SubmitButton size="sm" variant="secondary">Send invite</SubmitButton>
                </ActionForm>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pipeline timing</CardTitle>
              <CardDescription>Jobs idle longer than this in a stage are flagged stale (and will appear in the daily digest).</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveStaleDays} className="space-y-4">
                <fieldset disabled={!isOwner} className="space-y-4">
                  {pipelines.map((p) => (
                    <div key={p.key}>
                      <div className="mb-1 text-sm font-medium">{p.name}</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                        {p.stages
                          .filter((st) => !st.isTerminal)
                          .map((st) => (
                            <label key={st.key} className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate">{st.name}</span>
                              <Input name={`stale:${p.key}:${st.key}`} defaultValue={st.staleAfterDays ?? ""} inputMode="numeric" className="h-7 w-14 text-xs" aria-label={`${st.name} stale after days`} />
                            </label>
                          ))}
                      </div>
                    </div>
                  ))}
                  {isOwner && <SubmitButton size="sm">Save timings</SubmitButton>}
                </fieldset>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>AIRnyc upload checklist</CardTitle>
              <CardDescription>
                File-name tokens: {"{CASE_ID}"}, {"{LAST_NAME}"}, {"{DATE}"}. Defaults are placeholders — confirm AIRnyc&apos;s naming.
              </CardDescription>
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
                    {airnycStages.map((st) => <option key={st.key} value={st.key}>{st.name}</option>)}
                  </NativeSelect>
                  <Input name="label" placeholder="Item (e.g. Signed work order)" required />
                  <Input name="fileNamePattern" placeholder="{CASE_ID}_Work_Order.pdf" />
                  <SubmitButton size="sm" variant="secondary">Add item</SubmitButton>
                </ActionForm>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
