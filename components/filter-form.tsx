"use client";

import Form from "next/form";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A GET form that re-submits itself when a filter changes (selects/checkboxes right away, text after a
 * short pause) so lists update without hunting for an Enter key or a Search button. next/form keeps it a
 * client-side navigation.
 */
export function FilterForm({ action, children, className }: { action: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submit = () => ref.current?.requestSubmit();
  return (
    <Form
      action={action}
      ref={ref}
      role="search"
      className={cn("flex flex-wrap items-center gap-2", className)}
      onChange={(e) => {
        clearTimeout(timer.current);
        const t = e.target as unknown as HTMLInputElement;
        if (t.type === "search" || t.type === "text") timer.current = setTimeout(submit, 400);
        else submit();
      }}
    >
      {children}
    </Form>
  );
}
