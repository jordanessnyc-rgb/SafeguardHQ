import { eq } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { BRAND_INFO, type TemplateVars } from "./templates";

/** Template variables for a contact and/or job (SPEC §6.1 SMS templates). */
export async function templateVars(conn: Db | Tx, ids: { contactId?: string | null; jobId?: string | null }): Promise<TemplateVars> {
  const [contact] = ids.contactId ? await conn.select().from(s.contacts).where(eq(s.contacts.id, ids.contactId)) : [];
  const [row] = ids.jobId
    ? await conn
        .select({ job: s.jobs, address: s.properties.addressLine, unit: s.properties.unit })
        .from(s.jobs)
        .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
        .where(eq(s.jobs.id, ids.jobId))
    : [];
  const brand = BRAND_INFO[row?.job.brand ?? contact?.brand ?? "ESS"];
  const at = row?.job.scheduledAt;
  return {
    first_name: contact?.firstName,
    last_name: contact?.lastName,
    job_number: row?.job.jobNumber,
    address: row?.address ? `${row.address}${row.unit ? ` Apt ${row.unit}` : ""}` : undefined,
    scheduled_date: at ? fmtDate(at).replace(/, \d{4}$/, "") : undefined,
    scheduled_time: at ? at.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : undefined,
    brand_name: brand.name,
    brand_phone: brand.phone,
    review_url: process.env.REVIEW_URL,
  };
}
