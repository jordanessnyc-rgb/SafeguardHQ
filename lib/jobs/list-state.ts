import { listHref } from "@/lib/list";

type Params = Record<string, string | number | null | undefined>;

/** The selected view is explicit. A bare Jobs link opens the readable list. */
export function jobsView(params: Record<string, string | string[] | undefined>): "board" | "list" {
  return params.view === "board" ? "board" : "list";
}

/** Preserve shared filters; list-only filters cannot silently override a Board selection. */
export function jobsHref(current: Params, changes: Params = {}): string {
  const params = { ...current, ...changes };
  if (params.view === "board") {
    for (const key of ["stage", "service", "stale", "status", "sort", "page"]) delete params[key];
  } else delete params.bsort;
  return listHref("/jobs", params);
}
