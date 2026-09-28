import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/forms";
import { ClientPickers, type ContactOption, type PropertyOption } from "@/components/client-pickers";
import { toNyInput } from "@/lib/time";
import { BRAND_LABELS, SERVICE_LABELS, SOURCE_LABELS } from "@/lib/labels";

export type JobOptions = {
  properties: PropertyOption[];
  orgs: { id: string; name: string; type: string }[];
  contacts: ContactOption[];
  staff: { id: string; label: string }[];
};

type Job = Partial<{
  serviceCode: string;
  brand: string;
  propertyId: string | null;
  clientOrgId: string | null;
  clientContactId: string | null;
  priority: string;
  source: string | null;
  title: string | null;
  scheduledAt: Date | null;
  assignedTo: string | null;
  subOrgId: string | null;
  hpdViolationRef: string | null;
  nextCycleDue: string | null;
  notes: string | null;
}>;


export function JobFields({ job = {}, options, editing = false }: { job?: Job; options: JobOptions; editing?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {!editing && (
        <Field label="Service">
          <NativeSelect name="serviceCode" defaultValue={job.serviceCode ?? "MOLD_ASSESS"} required>
            {Object.entries(SERVICE_LABELS)
              .filter(([k]) => k !== "BID")
              .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
        </Field>
      )}
      <Field label="Brand">
        <NativeSelect name="brand" defaultValue={job.brand ?? "ESS"}>
          {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <ClientPickers
        properties={options.properties}
        orgs={options.orgs.map((o) => ({ id: o.id, label: o.name }))}
        contacts={options.contacts}
        defaults={{ propertyId: job.propertyId, clientOrgId: job.clientOrgId, clientContactId: job.clientContactId }}
      />
      <Field label="Priority">
        <NativeSelect name="priority" defaultValue={job.priority ?? "NORMAL"}>
          {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Lead source">
        <NativeSelect name="source" defaultValue={job.source ?? ""}>
          <option value="">—</option>
          {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Scheduled (field visit)">
        <Input type="datetime-local" name="scheduledAt" defaultValue={toNyInput(job.scheduledAt)} />
      </Field>
      <Field label="Assigned to">
        <NativeSelect name="assignedTo" defaultValue={job.assignedTo ?? ""}>
          <option value="">—</option>
          {options.staff.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Subcontractor">
        <NativeSelect name="subOrgId" defaultValue={job.subOrgId ?? ""}>
          <option value="">—</option>
          {options.orgs.filter((o) => o.type === "SUBCONTRACTOR").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="HPD violation ref">
        <Input name="hpdViolationRef" defaultValue={job.hpdViolationRef ?? ""} />
      </Field>
      {editing && (
        <Field label="Next compliance cycle due" hint="Filled in when the job is Closed (Compliance rules); set it here to override.">
          <Input name="nextCycleDue" type="date" defaultValue={job.nextCycleDue ?? ""} />
        </Field>
      )}
      <Field label="Short description" className="sm:col-span-2">
        <Input name="title" defaultValue={job.title ?? ""} placeholder="e.g. Bathroom + bedroom 2 mold, tenant complaint" />
      </Field>
      <Field label="Notes" className="sm:col-span-2">
        <Textarea name="notes" rows={3} defaultValue={job.notes ?? ""} />
      </Field>
    </div>
  );
}
