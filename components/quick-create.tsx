"use client";

import { useState, useTransition, type ReactNode } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ORG_TYPE_LABELS } from "@/lib/labels";
import { searchAddress } from "@/app/(app)/properties/actions";
import { quickCreateContact, quickCreateOrganization, quickCreateProperty, type Created } from "@/app/(app)/quick-create/actions";
import type { AddressCandidate } from "@/lib/integrations/nyc-open-data";

type Props = { open: boolean; onOpenChange: (open: boolean) => void; typed: string; onCreated: (c: Created) => void };

/**
 * The dialogs are portaled outside the page's form, and they use no <form> or `name` attributes of their
 * own, so nothing here can submit (or add fields to) the job form behind them.
 */
function Shell({ open, onOpenChange, title, description, children, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; children: ReactNode; footer: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">{children}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const enter = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fn();
  }
};

export function QuickOrgDialog({ open, onOpenChange, typed, onCreated }: Props) {
  const [name, setName] = useState(typed);
  const [type, setType] = useState("MANAGEMENT_CO");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await quickCreateOrganization({ name, type: type as never, email });
      if (r.error || !r.created) return setError(r.error ?? "Couldn't save.");
      onCreated(r.created);
      onOpenChange(false);
    });
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="New organization"
      description="Add the company now; fill in the rest on its page later."
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending || !name.trim()}>{pending ? "Saving…" : "Add organization"}</Button>
        </>
      }
    >
      <div className="grid gap-1.5">
        <Label htmlFor="qo-name">Name</Label>
        <Input id="qo-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter(save)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="qo-type">Type</Label>
          <NativeSelect id="qo-type" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(ORG_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qo-email">Billing email (optional)</Label>
          <Input id="qo-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter(save)} />
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Shell>
  );
}

export function QuickContactDialog({ open, onOpenChange, typed, onCreated, org }: Props & { org?: { id: string; name: string } | null }) {
  const [first, ...last] = typed.split(/\s+/);
  const [firstName, setFirstName] = useState(first ?? "");
  const [lastName, setLastName] = useState(last.join(" "));
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [atOrg, setAtOrg] = useState(Boolean(org));
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await quickCreateContact({ firstName, lastName, phone, email, orgId: atOrg && org ? org.id : undefined });
      if (r.error || !r.created) return setError(r.error ?? "Couldn't save.");
      onCreated(r.created);
      onOpenChange(false);
    });
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="New contact"
      description="Name plus a phone or email is enough to start."
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending || !(firstName.trim() || lastName.trim())}>{pending ? "Saving…" : "Add contact"}</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="qc-first">First name</Label>
          <Input id="qc-first" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} onKeyDown={enter(save)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qc-last">Last name</Label>
          <Input id="qc-last" value={lastName} onChange={(e) => setLastName(e.target.value)} onKeyDown={enter(save)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qc-phone">Phone</Label>
          <Input id="qc-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={enter(save)} placeholder="929-555-0100" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qc-email">Email</Label>
          <Input id="qc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter(save)} />
        </div>
      </div>
      {org && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={atOrg} onChange={(e) => setAtOrg(e.target.checked)} className="size-4 accent-primary" />
          Works at {org.name}
        </label>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Shell>
  );
}

type Candidate = Omit<AddressCandidate, "raw">;

export function QuickPropertyDialog({ open, onOpenChange, typed, onCreated }: Props) {
  const [query, setQuery] = useState(typed);
  const [unit, setUnit] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const lookUp = () =>
    start(async () => {
      setError(undefined);
      const r = await searchAddress(query);
      setCandidates(r.candidates);
      if (r.error) setError(r.error);
    });
  const create = (c: Partial<Candidate> & { addressLine: string }) =>
    start(async () => {
      const r = await quickCreateProperty({ addressLine: c.addressLine, unit, borough: c.borough ?? undefined, zip: c.zip ?? undefined, bbl: c.bbl ?? undefined, bin: c.bin ?? undefined, lat: c.lat ?? null, lng: c.lng ?? null });
      if (r.error || !r.created) return setError(r.error ?? "Couldn't save.");
      onCreated(r.created);
      onOpenChange(false);
    });
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="New property"
      description="Look the address up so the building's city records and violations load automatically."
      footer={<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="qp-address">Address</Label>
          <div className="flex gap-2">
            <Input id="qp-address" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={enter(lookUp)} placeholder="e.g. 47-58 43rd Street, Queens" />
            <Button type="button" onClick={lookUp} disabled={pending || query.trim().length < 3}>{pending ? "…" : "Look up"}</Button>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qp-unit">Apt / unit</Label>
          <Input id="qp-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="optional" />
        </div>
      </div>
      {candidates && (
        <div className="grid max-h-64 gap-1.5 overflow-y-auto">
          {candidates.length === 0 && <p className="text-sm text-muted-foreground">No NYC match. Check the spelling, or save it as typed.</p>}
          {candidates.map((c, i) => (
            <button key={i} type="button" disabled={pending} onClick={() => create(c)} className="flex items-start gap-2 rounded-lg border p-2 text-left text-sm hover:border-primary hover:bg-sidebar">
              <MapPin className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">{c.addressLine}</span>, {c.borough} {c.zip}
                {c.bbl && <span className="block text-xs text-muted-foreground">BBL {c.bbl}</span>}
              </span>
            </button>
          ))}
          <Button type="button" variant="ghost" size="sm" className="justify-start" disabled={pending || query.trim().length < 3} onClick={() => create({ addressLine: query.trim() })}>
            Save “{query.trim()}” as typed (not matched to a building)
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Shell>
  );
}
