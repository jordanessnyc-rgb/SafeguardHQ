import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/forms";
import { titleCase } from "@/lib/labels";
import type { AirnycCase } from "@/lib/airnyc/cases";

const CONSENT = ["NOT_REQUESTED", "REQUESTED", "RECEIVED", "DECLINED", "NOT_REQUIRED"];
const QC = ["NOT_SUBMITTED", "SUBMITTED", "REVISIONS_REQUESTED", "APPROVED"];

export function CaseFields({ c, properties }: { c?: Partial<AirnycCase>; properties: { id: string; label: string }[] }) {
  return (
    <div className="space-y-4">
      <fieldset className="grid gap-3 rounded-lg border border-amber-300 p-3 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-amber-800">Member info — encrypted, every view is logged</legend>
        <Field label="Case ID" hint="e.g. PHS_0148 — the prefix sets the network.">
          <Input name="caseId" defaultValue={c?.caseId} required />
        </Field>
        <Field label="Member name"><Input name="memberName" defaultValue={c?.memberName ?? ""} autoComplete="off" /></Field>
        <Field label="Guardian name"><Input name="guardianName" defaultValue={c?.guardianName ?? ""} autoComplete="off" /></Field>
        <Field label="Member phone"><Input name="memberPhone" type="tel" defaultValue={c?.memberPhone ?? ""} autoComplete="off" /></Field>
        <Field label="Member address (incl. apt)" className="sm:col-span-2"><Input name="address" defaultValue={c?.address ?? ""} autoComplete="off" /></Field>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Building (property)" className="sm:col-span-2" hint="Link the building so violations and jobs connect. Create it under Properties first.">
          <NativeSelect name="propertyId" defaultValue={c?.propertyId ?? ""}>
            <option value="">—</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Case manager"><Input name="caseManagerName" defaultValue={c?.caseManagerName ?? ""} /></Field>
        <Field label="Case manager email"><Input name="caseManagerEmail" type="email" defaultValue={c?.caseManagerEmail ?? ""} /></Field>
        <Field label="Approved services" hint="Comma-separated, e.g. 2.2a Mold, 2.3b Asthma Remediation" className="sm:col-span-2">
          <Input name="approvedServices" defaultValue={c?.approvedServices?.join(", ")} />
        </Field>
        <Field label="Tenant consent">
          <NativeSelect name="tenantConsentStatus" defaultValue={c?.tenantConsentStatus ?? "NOT_REQUESTED"}>
            {CONSENT.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Landlord consent">
          <NativeSelect name="landlordConsentStatus" defaultValue={c?.landlordConsentStatus ?? "NOT_REQUESTED"}>
            {CONSENT.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
          </NativeSelect>
        </Field>
        <Field label="QC reviewer"><Input name="qcReviewer" defaultValue={c?.qcReviewer ?? ""} /></Field>
        <Field label="QC status">
          <NativeSelect name="qcStatus" defaultValue={c?.qcStatus ?? "NOT_SUBMITTED"}>
            {QC.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Tracker row #"><Input name="trackerRow" inputMode="numeric" defaultValue={c?.trackerRow ?? ""} /></Field>
        <Field label="SharePoint folder URL"><Input name="sharepointFolderUrl" type="url" defaultValue={c?.sharepointFolderUrl ?? ""} /></Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isNycha" defaultChecked={c?.isNycha} className="size-4 accent-primary" /> NYCHA building (consent risk)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="scopeNotCovered" defaultChecked={c?.scopeNotCovered} className="size-4 accent-primary" /> Approved services don&apos;t cover recommended scope
        </label>
        <Field label="Out-of-scope observations (pests, etc. — separate referral)" className="sm:col-span-2">
          <Textarea name="outOfScopeObservations" rows={2} defaultValue={c?.outOfScopeObservations ?? ""} />
        </Field>
      </div>
    </div>
  );
}
