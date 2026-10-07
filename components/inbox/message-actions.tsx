"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Forward, Phone, Reply, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { ComposeMessage, type ComposeInitial } from "@/components/compose-message";
import { archiveMessage, deleteMessage, restoreMessage } from "@/app/(app)/comms/mail-actions";

type Props = {
  activityId: string;
  /** Where to go once this message leaves the list (the next one, like a mail app). */
  nextHref: string;
  archived: boolean;
  reply: ComposeInitial;
  forward: ComposeInitial | null;
  /** E.164 number to call. Quo has no API to start a call, so this opens the phone/Quo app. */
  call?: string | null;
  compose: {
    phones: string[];
    emails: string[];
    lines: { id: string; label: string }[];
    templates: { key: string; name: string; channel: "SMS" | "EMAIL" }[];
    defaultFromEmail: string;
    context: { contactId?: string; jobId?: string; airnycCaseId?: string };
    documents: { id: string; title: string; containsPricing: boolean }[];
    isOwner: boolean;
  };
};

/** Reply / forward / archive / delete on an open message. Sending is immediate: the click is the approval. */
export function MessageActions({ activityId, nextHref, archived, reply, forward, call, compose }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"reply" | "forward" | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: (id: string) => Promise<{ ok?: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn(activityId);
      if (r.error) return void toast.error(r.error);
      toast.success(r.message ?? "Done.");
      router.replace(nextHref, { scroll: false });
    });

  return (
    <section aria-label="Message actions" className="space-y-3 rounded-xl bg-muted/50 p-3 ring-1 ring-black/[0.04]">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant={mode === "reply" ? "default" : "outline"} onClick={() => setMode(mode === "reply" ? null : "reply")}>
          <Reply /> {reply.channel === "SMS" ? "Text back" : "Reply"}
        </Button>
        {forward && (
          <Button type="button" size="sm" variant={mode === "forward" ? "default" : "outline"} onClick={() => setMode(mode === "forward" ? null : "forward")}>
            <Forward /> Forward
          </Button>
        )}
        {call && (
          <a href={`tel:${call}`} title="Opens your phone or the Quo app to place the call" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Phone /> Call
          </a>
        )}
        <span className="flex-1" />
        {archived ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(restoreMessage)}>
            <ArchiveRestore /> Put back in inbox
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(archiveMessage)}>
            <Archive /> Archive
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" className="text-destructive" disabled={pending} onClick={() => run(deleteMessage)}>
          <Trash2 /> Delete
        </Button>
      </div>
      {mode && (
        <div className="rounded-xl bg-card p-4 shadow-card ring-1 ring-black/[0.05]">
          <ComposeMessage
            key={mode}
            phones={compose.phones}
            emails={compose.emails}
            lines={compose.lines}
            templates={compose.templates}
            defaultFromEmail={compose.defaultFromEmail}
            context={compose.context}
            revalidate="/inbox"
            isOwner={compose.isOwner}
            freeTo
            initial={mode === "reply" ? reply : forward!}
            documents={compose.documents}
            onSent={() => {
              setMode(null);
              router.refresh();
            }}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Archive and Delete move the email in your Titan mailbox too (within a minute). Texts and calls only change here. Nothing is sent without you pressing Send.
      </p>
    </section>
  );
}
