import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/forms";
import { BRAND_LABELS, ORG_TYPE_LABELS } from "@/lib/labels";

type Org = { holdReportUntilPaid?: boolean | null; name?: string; type?: string; brand?: string; website?: string | null; phone?: string | null; email?: string | null; notes?: string | null };

export function OrgFields({ org = {} }: { org?: Org }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" className="sm:col-span-2">
        <Input name="name" defaultValue={org.name} required />
      </Field>
      <Field label="Type">
        <NativeSelect name="type" defaultValue={org.type ?? "MANAGEMENT_CO"}>
          {Object.entries(ORG_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Brand">
        <NativeSelect name="brand" defaultValue={org.brand ?? "ESS"}>
          {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Phone">
        <Input name="phone" type="tel" defaultValue={org.phone ?? ""} />
      </Field>
      <Field label="Email">
        <Input name="email" type="email" defaultValue={org.email ?? ""} />
      </Field>
      <Field label="Hold reports until paid" hint="For this client's jobs, unless a job says otherwise.">
        <NativeSelect name="holdReportUntilPaid" defaultValue={org.holdReportUntilPaid == null ? "" : String(org.holdReportUntilPaid)}>
          <option value="">Use the default (Settings)</option>
          <option value="true">Yes — hold until paid</option>
          <option value="false">No</option>
        </NativeSelect>
      </Field>
      <Field label="Website">
        <Input name="website" defaultValue={org.website ?? ""} />
      </Field>
      <Field label="Notes" className="sm:col-span-2">
        <Textarea name="notes" rows={3} defaultValue={org.notes ?? ""} />
      </Field>
    </div>
  );
}
