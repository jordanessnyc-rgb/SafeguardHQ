"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type Size = "default" | "sm" | "lg" | "xs";

/**
 * Drop-in for a destructive form's submit button: asks first, then submits the surrounding form.
 * Use inside `<form action={serverAction}>`.
 */
export function ConfirmSubmit({
  children,
  title,
  description,
  confirmLabel = "Yes, do it",
  variant = "ghost",
  size = "xs",
  className,
}: {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  variant?: Variant;
  size?: Size;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor} className="contents">
      <Button type="button" variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                anchor.current?.closest("form")?.requestSubmit();
              }}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
