import { getTableName, sql, type Column, type SQL } from "drizzle-orm";

/**
 * A column written as "table"."column" inside a raw sql`` fragment.
 *
 * Drizzle leaves columns unqualified in single-table queries ("id"), so an outer column used inside a
 * correlated subquery — `(select … from jobs j where j.property_id = ${s.properties.id})` — silently
 * binds to the subquery's own table (j.id) and matches nothing. Always wrap outer columns with this.
 */
export const col = (c: Column): SQL => sql`${sql.identifier(getTableName(c.table))}.${sql.identifier(c.name)}`;
