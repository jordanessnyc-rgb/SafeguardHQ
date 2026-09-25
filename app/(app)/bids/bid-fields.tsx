import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Field } from "@/components/forms";
import type { schema } from "@/lib/db";
import { toNyInput } from "@/lib/time";

type Bid = Partial<typeof schema.bids.$inferSelect>;

export function BidFields({ bid = {} }: { bid?: Bid }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Title" className="sm:col-span-2"><Input name="title" defaultValue={bid.title ?? ""} required /></Field>
      <Field label="Agency"><Input name="agency" defaultValue={bid.agency ?? ""} /></Field>
      <Field label="Solicitation #"><Input name="solicitationNumber" defaultValue={bid.solicitationNumber ?? ""} /></Field>
      <Field label="Type">
        <NativeSelect name="type" defaultValue={bid.type ?? "RFP"}>
          {["RFP", "RFQ", "RFB", "IFB", "OTHER"].map((t) => <option key={t}>{t}</option>)}
        </NativeSelect>
      </Field>
      <Field label="ESS role">
        <NativeSelect name="role" defaultValue={bid.role ?? "PRIME"}>
          <option value="PRIME">Prime</option>
          <option value="SUB">Sub (to another prime)</option>
        </NativeSelect>
      </Field>
      <Field label="Prime entity" hint="ESS, or the partner firm when ESS is a sub."><Input name="primeEntity" defaultValue={bid.primeEntity ?? "ESS"} /></Field>
      <Field label="Link to listing"><Input name="sourceUrl" defaultValue={bid.sourceUrl ?? ""} /></Field>
      <Field label="Questions due"><Input name="questionsDue" type="datetime-local" defaultValue={toNyInput(bid.questionsDue)} /></Field>
      <Field label="Site visit"><Input name="siteVisitAt" type="datetime-local" defaultValue={toNyInput(bid.siteVisitAt)} /></Field>
      <Field label="Due"><Input name="dueAt" type="datetime-local" defaultValue={toNyInput(bid.dueAt)} /></Field>
      <Field label="Opening"><Input name="openingAt" type="datetime-local" defaultValue={toNyInput(bid.openingAt)} /></Field>
      <Field label="Buyer"><Input name="buyerName" defaultValue={bid.buyerName ?? ""} /></Field>
      <Field label="Buyer email"><Input name="buyerEmail" type="email" defaultValue={bid.buyerEmail ?? ""} /></Field>
      <Field label="Buyer phone"><Input name="buyerPhone" defaultValue={bid.buyerPhone ?? ""} /></Field>
      <div />
      <Field label="Scope" className="sm:col-span-2"><Textarea name="scope" rows={3} defaultValue={bid.scope ?? ""} /></Field>
      <Field label="Insurance requirements" className="sm:col-span-2"><Textarea name="insuranceRequirements" rows={2} defaultValue={bid.insuranceRequirements ?? ""} /></Field>
      <Field label="Notes" className="sm:col-span-2"><Textarea name="notes" rows={2} defaultValue={bid.notes ?? ""} /></Field>
    </div>
  );
}
