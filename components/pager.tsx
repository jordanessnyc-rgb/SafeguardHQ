import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "Showing 51–100 of 663" with Previous / Next. Renders just the count when everything fits on one page. */
export function Pager({ total, from, to, page, pages, href, noun = "results", className }: {
  total: number;
  from: number;
  to: number;
  page: number;
  pages: number;
  href: (page: number) => string;
  noun?: string;
  className?: string;
}) {
  if (!total) return null;
  return (
    <nav aria-label="Pages" className={cn("flex flex-wrap items-center justify-between gap-2 py-3 text-sm text-muted-foreground", className)}>
      <span>
        {pages > 1 ? `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ` : ""}
        <span className="font-medium text-foreground">{total.toLocaleString()}</span> {noun}
      </span>
      {pages > 1 && (
        <span className="flex items-center gap-2">
          {page > 1 ? <Link href={href(page - 1)} className={buttonVariants({ size: "sm", variant: "outline" })}>Previous</Link> : <span className={cn(buttonVariants({ size: "sm", variant: "outline" }), "pointer-events-none opacity-50")}>Previous</span>}
          <span className="tabular-nums">Page {page} of {pages}</span>
          {page < pages ? <Link href={href(page + 1)} className={buttonVariants({ size: "sm", variant: "outline" })}>Next</Link> : <span className={cn(buttonVariants({ size: "sm", variant: "outline" }), "pointer-events-none opacity-50")}>Next</span>}
        </span>
      )}
    </nav>
  );
}
