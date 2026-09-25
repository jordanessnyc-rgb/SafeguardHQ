"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const COMMON = ["Chose another firm", "Price", "No response", "Not needed after all"];

/** Asks why a job was lost (required) — replaces window.prompt, which phones and screen readers handle badly. */
export function LostReasonDialog({
  jobNumber,
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  jobNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  pending?: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), o || setReason(""))}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) onConfirm(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark {jobNumber} as lost</DialogTitle>
            <DialogDescription>The reason is saved on the job and shows up in reports.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="lost-reason">Why was it lost?</Label>
            <Input id="lost-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. chose another firm" />
            <div className="flex flex-wrap gap-1.5">
              {COMMON.map((c) => (
                <Button key={c} type="button" size="xs" variant="outline" onClick={() => setReason(c)}>
                  {c}
                </Button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!trimmed || pending}>
              {pending ? "Saving…" : "Mark lost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
