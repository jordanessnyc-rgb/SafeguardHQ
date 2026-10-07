"use client";

import { useState } from "react";
import { PenSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ComposeMessage, type ComposeInitial } from "@/components/compose-message";

type Props = {
  lines: { id: string; label: string }[];
  templates: { key: string; name: string; channel: "SMS" | "EMAIL" }[];
  defaultFromEmail: string;
  isOwner: boolean;
  /** Preset the channel/recipient (e.g. "New text" from a conversation). */
  initial?: ComposeInitial;
  label?: string;
};

/** "New message" button that opens a compose dialog to anyone — an address or number typed in. */
export function NewMessageButton({ lines, templates, defaultFromEmail, isOwner, initial, label = "New message" }: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PenSquare /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>Email goes out from your Titan mailbox; texts from a Quo line. Nothing is sent until you press Send.</DialogDescription>
          </DialogHeader>
          {open && (
            <ComposeMessage
              freeTo
              phones={[]}
              emails={[]}
              lines={lines}
              templates={templates}
              defaultFromEmail={defaultFromEmail}
              context={{}}
              revalidate="/inbox"
              isOwner={isOwner}
              initial={initial}
              onSent={() => {
                setOpen(false);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
