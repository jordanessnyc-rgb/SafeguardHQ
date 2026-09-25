"use client";

import { useState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string };

/** Role picker whose subcontractor-organization picker only appears when the role is Sub. */
export function RoleFields({
  roles,
  subOrgs,
  defaultRole,
  defaultOrgId,
  compact,
}: {
  roles: Option[];
  subOrgs: { id: string; name: string }[];
  defaultRole: string;
  defaultOrgId?: string | null;
  compact?: boolean;
}) {
  const [role, setRole] = useState(defaultRole);
  const size = compact ? "h-7 text-xs" : "";
  return (
    <>
      <NativeSelect name="role" value={role} onChange={(e) => setRole(e.target.value)} className={cn(size, compact && "w-28")} aria-label="Role">
        {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </NativeSelect>
      {role === "SUB" ? (
        <NativeSelect name="orgId" defaultValue={defaultOrgId ?? ""} required className={cn(size, compact && "w-40")} aria-label="Subcontractor company">
          <option value="">Choose subcontractor company…</option>
          {subOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </NativeSelect>
      ) : (
        <input type="hidden" name="orgId" value="" />
      )}
    </>
  );
}
