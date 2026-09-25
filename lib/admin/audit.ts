/** Human summary of an audit_log row: which fields changed, old → new. Pure. */
const SKIP = new Set(["id", "created_at", "updated_at", "created_by"]);
const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));

export function auditChanges(action: string, detail: unknown): string {
  const d = (detail ?? {}) as { old?: Record<string, unknown> | null; new?: Record<string, unknown> | null };
  if (action === "UPDATE" && d.old && d.new) {
    const changed = Object.keys(d.new).filter((k) => !SKIP.has(k) && JSON.stringify(d.old![k]) !== JSON.stringify(d.new![k]));
    return changed.length ? changed.map((k) => `${k}: ${show(d.old![k])} → ${show(d.new![k])}`).join("; ") : "no field changes";
  }
  const row = d.new ?? d.old;
  if ((action === "INSERT" || action === "DELETE") && row) {
    return Object.entries(row).filter(([k, v]) => !SKIP.has(k) && v != null).slice(0, 6).map(([k, v]) => `${k}: ${show(v)}`).join("; ");
  }
  return typeof detail === "object" && detail ? JSON.stringify(detail).slice(0, 200) : "";
}
