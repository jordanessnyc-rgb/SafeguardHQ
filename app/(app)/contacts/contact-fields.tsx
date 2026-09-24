import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/forms";
import { BRAND_LABELS, SOURCE_LABELS } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";

type Contact = {
  firstName?: string | null;
  lastName?: string | null;
  orgId?: string | null;
  title?: string | null;
  emails?: string[];
  phones?: string[];
  preferredChannel?: string | null;
  source?: string;
  brand?: string;
  doNotContact?: boolean;
  notes?: string | null;
};

export function ContactFields({ contact = {}, orgs }: { contact?: Contact; orgs: { id: string; name: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="First name"><Input name="firstName" defaultValue={contact.firstName ?? ""} /></Field>
      <Field label="Last name"><Input name="lastName" defaultValue={contact.lastName ?? ""} /></Field>
      <Field label="Organization">
        <NativeSelect name="orgId" defaultValue={contact.orgId ?? ""}>
          <option value="">— none —</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Title"><Input name="title" defaultValue={contact.title ?? ""} /></Field>
      <Field label="Emails" hint="Separate multiple with commas.">
        <Input name="emails" defaultValue={contact.emails?.join(", ")} />
      </Field>
      <Field label="Phones" hint="Separate multiple with commas. Stored as E.164.">
        <Input name="phones" type="tel" defaultValue={contact.phones?.map(formatPhone).join(", ")} />
      </Field>
      <Field label="Preferred channel">
        <NativeSelect name="preferredChannel" defaultValue={contact.preferredChannel ?? ""}>
          <option value="">—</option>
          <option value="PHONE">Phone</option>
          <option value="SMS">SMS</option>
          <option value="EMAIL">Email</option>
        </NativeSelect>
      </Field>
      <Field label="Source">
        <NativeSelect name="source" defaultValue={contact.source ?? "MANUAL"}>
          {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Brand">
        <NativeSelect name="brand" defaultValue={contact.brand ?? "ESS"}>
          {Object.entries(BRAND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </NativeSelect>
      </Field>
      <label className="flex items-center gap-2 self-end pb-1 text-sm">
        <input type="checkbox" name="doNotContact" defaultChecked={contact.doNotContact} className="size-4 accent-primary" /> Do not contact
      </label>
      <Field label="Notes" className="sm:col-span-2"><Textarea name="notes" rows={3} defaultValue={contact.notes ?? ""} /></Field>
    </div>
  );
}
