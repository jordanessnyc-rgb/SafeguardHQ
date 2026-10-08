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
    <nav aria-label="Clients & properties" className="seg mb-5">
      {RECORDS.map(({ href, label }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("seg-item", active && "seg-on")}>{label}</Link>;
      })}
    </nav>
  );
}
