/** Paging for the record lists: 50 rows a page, `?page=N` (1-based), with a "showing X–Y of Z" line. */
export const PAGE_SIZE = 50;

export function pageFrom(v: string | string[] | undefined): number {
  const n = Number(typeof v === "string" ? v : "1");
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function pageWindow(total: number, page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  return { page: current, pages, offset: (current - 1) * size, from: total ? (current - 1) * size + 1 : 0, to: Math.min(total, current * size) };
}

/** Builds a list URL from the current params, dropping empty values (and page 1). */
export function listHref(path: string, params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && !(k === "page" && Number(v) === 1)) p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}
