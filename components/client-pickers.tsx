"use client";

import { useMemo, useState } from "react";
import { Field } from "@/components/forms";
import { SearchSelect, type PickOption } from "@/components/search-select";
import { QuickContactDialog, QuickOrgDialog, QuickPropertyDialog } from "@/components/quick-create";
import type { Created } from "@/app/(app)/quick-create/actions";

export type PropertyOption = PickOption & { orgIds: string[] };
export type ContactOption = PickOption & { orgId: string | null };
export type OrgOption = PickOption;

/**
 * Property → client company → client contact, the way a job is usually started:
 *  - picking a building fills in its owner/manager company (when none is chosen yet);
 *  - picking a person fills in their company;
 *  - the chosen company's people are listed first;
 *  - each picker can add a new record without leaving the form.
 * Submits propertyId, clientOrgId and clientContactId like the plain selects did.
 */
export function ClientPickers({
  properties: initialProperties,
  orgs: initialOrgs,
  contacts: initialContacts,
  defaults,
  showProperty = true,
  names = { org: "clientOrgId", contact: "clientContactId" },
  labels = { org: "Client organization", contact: "Client contact" },
}: {
  properties: PropertyOption[];
  orgs: OrgOption[];
  contacts: ContactOption[];
  defaults: { propertyId?: string | null; clientOrgId?: string | null; clientContactId?: string | null };
  showProperty?: boolean;
  names?: { org: string; contact: string };
  labels?: { org: string; contact: string };
}) {
  const [properties, setProperties] = useState(initialProperties);
  const [orgs, setOrgs] = useState(initialOrgs);
  const [contacts, setContacts] = useState(initialContacts);
  const [propertyId, setPropertyId] = useState(defaults.propertyId ?? null);
  const [orgId, setOrgId] = useState(defaults.clientOrgId ?? null);
  const [contactId, setContactId] = useState(defaults.clientContactId ?? null);
  const [adding, setAdding] = useState<{ kind: "property" | "org" | "contact"; typed: string } | null>(null);

  const selectedContact = contacts.find((c) => c.id === contactId);
  const companyMismatch = orgId && selectedContact?.orgId && selectedContact.orgId !== orgId;
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const orgPeople = useMemo(() => new Set(contacts.filter((c) => orgId && c.orgId === orgId).map((c) => c.id)), [contacts, orgId]);
  const buildingOrgs = useMemo(() => new Set(properties.find((p) => p.id === propertyId)?.orgIds ?? []), [properties, propertyId]);

  const onProperty = (p: PickOption | undefined) => {
    setPropertyId(p?.id ?? null);
    const fromBuilding = (p as PropertyOption | undefined)?.orgIds?.[0];
    if (!orgId && fromBuilding) setOrgId(fromBuilding);
  };
  const onContact = (c: PickOption | undefined) => {
    setContactId(c?.id ?? null);
    const theirOrg = (c as ContactOption | undefined)?.orgId;
    if (!orgId && theirOrg) setOrgId(theirOrg);
  };
  const created = (kind: "property" | "org" | "contact") => (c: Created) => {
    if (kind === "property") {
      setProperties((l) => (l.some((p) => p.id === c.id) ? l : [{ id: c.id, label: c.label, orgIds: [] }, ...l]));
      setPropertyId(c.id);
    } else if (kind === "org") {
      setOrgs((l) => [{ id: c.id, label: c.label }, ...l]);
      setOrgId(c.id);
    } else {
      setContacts((l) => [{ id: c.id, label: c.label, detail: c.detail, orgId: c.orgId ?? null }, ...l]);
      setContactId(c.id);
      if (!orgId && c.orgId) setOrgId(c.orgId);
    }
  };

  return (
    <>
      {showProperty && (
        <Field label="Property" className="sm:col-span-2">
          <SearchSelect
            name="propertyId"
            label="Property"
            noun="properties"
            placeholder="Type an address…"
            options={properties}
            value={propertyId}
            onChange={onProperty}
            onAddNew={(typed) => setAdding({ kind: "property", typed })}
            addNewLabel="New property"
          />
        </Field>
      )}
      <Field label={labels.org} hint={buildingOrgs.size && !orgId ? "Tip: this building's owner or manager is listed first." : undefined}>
        <SearchSelect
          name={names.org}
          label={labels.org}
          noun="organizations"
          placeholder="Type a company name…"
          options={orgs}
          value={orgId}
          onChange={(o) => setOrgId(o?.id ?? null)}
          preferred={buildingOrgs}
          preferredLabel="This building"
          onAddNew={(typed) => setAdding({ kind: "org", typed })}
          addNewLabel="New organization"
        />
      </Field>
      <Field label={labels.contact}>
        <SearchSelect
          name={names.contact}
          label={labels.contact}
          noun="contacts"
          placeholder="Type a name, email or phone…"
          options={contacts}
          value={contactId}
          onChange={onContact}
          preferred={orgPeople}
          preferredLabel={org ? `At ${org.label}` : undefined}
          onAddNew={(typed) => setAdding({ kind: "contact", typed })}
          addNewLabel="New contact"
        />
      </Field>
      {companyMismatch && <p role="status" className="text-xs text-amber-800 dark:text-amber-300 sm:col-span-2">The selected person belongs to a different company. Confirm that this person is the right contact for this client&apos;s job.</p>}
      {adding?.kind === "property" && <QuickPropertyDialog open onOpenChange={(o) => o || setAdding(null)} typed={adding.typed} onCreated={created("property")} />}
      {adding?.kind === "org" && <QuickOrgDialog open onOpenChange={(o) => o || setAdding(null)} typed={adding.typed} onCreated={created("org")} />}
      {adding?.kind === "contact" && (
        <QuickContactDialog open onOpenChange={(o) => o || setAdding(null)} typed={adding.typed} onCreated={created("contact")} org={org ? { id: org.id, name: org.label } : null} />
      )}
    </>
  );
}
