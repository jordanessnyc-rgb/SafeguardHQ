"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const RECORDS = [
  { href: "/properties", label: "Properties" },
  { href: "/contacts", label: "People" },
  { href: "/organizations", label: "Companies" },
];

export function RecordsNav() {
  const path = usePathname();
  return (
    <nav aria-label="Clients & properties" className="mb-5 flex gap-1 border-b">
      {RECORDS.map(({ href, label }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("-mb-px border-b-2 px-4 py-2 text-sm", active ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</Link>;
      })}
    </nav>
  );
}
