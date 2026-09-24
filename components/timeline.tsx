import { ArrowDownLeft, ArrowUpRight, Mail, MessageSquare, Paperclip, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RevealSensitive } from "@/components/reveal-sensitive";
import { ActionForm, SubmitButton } from "@/components/forms";
import { draftAiReply } from "@/app/(app)/comms/actions";
import { fmtDate, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";

export type TimelineItem = {
  id: string;
  type: string;
  direction?: string | null;
  subject: string | null;
  body: string | null;
  summary: string | null;
  transcript?: string | null;
  nextSteps?: string[] | null;
  occurredAt: Date;
  externalUrl?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  channelLine?: string | null;
  callStatus?: string | null;
  durationSeconds?: number | null;
  attachments?: { filename: string; documentId?: string; ownerOnly?: boolean }[] | null;
  triageCategory?: string | null;
  triageStatus?: string | null;
  sensitive?: boolean;
  aiClassification?: unknown;
};

type Extraction = { address: string | null; service_code: string | null; urgency: string; summary: string; follow_ups: { title: string }[] };

const ICON: Record<string, typeof Phone> = { CALL: Phone, SMS: MessageSquare, EMAIL_IN: Mail, EMAIL_OUT: Mail };
const who = (v?: string | null) => (v ? (v.startsWith("+") ? formatPhone(v) : v) : "");
const mins = (sec?: number | null) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : null);

/** Unified activity timeline (SPEC §4.6): calls, texts, emails, notes, stage changes. */
export function Timeline({ items, viewerIsOwner = false }: { items: TimelineItem[]; viewerIsOwner?: boolean }) {
  const aiReplies = Boolean(process.env.ANTHROPIC_API_KEY);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="space-y-4 border-l pl-4">
      {items.map((a) => {
        const Icon = ICON[a.type];
        const inbound = a.direction === "INBOUND";
        return (
          <li key={a.id} className="relative text-sm">
            <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary" aria-hidden />
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {Icon && <Icon className="size-3.5" aria-hidden />}
              {a.direction && a.direction !== "INTERNAL" && (inbound ? <ArrowDownLeft className="size-3" aria-label="inbound" /> : <ArrowUpRight className="size-3" aria-label="outbound" />)}
              <span>{a.type === "CALL" ? "Call" : a.type === "SMS" ? "Text" : titleCase(a.type)}</span>
              <span>· {fmtDate(a.occurredAt, true)}</span>
              {(a.fromAddress || a.toAddress) && a.direction !== "INTERNAL" && <span>· {inbound ? `from ${who(a.fromAddress)}` : `to ${who(a.toAddress)}`}</span>}
              {a.channelLine && <span>· {a.channelLine}</span>}
              {a.type === "CALL" && a.callStatus && <Badge variant={a.callStatus === "answered" ? "secondary" : "destructive"}>{a.callStatus}</Badge>}
              {mins(a.durationSeconds) && <span>· {mins(a.durationSeconds)}</span>}
              {a.triageCategory && <Badge variant="outline">{titleCase(a.triageCategory)}</Badge>}
              {a.triageStatus === "NEEDS_REVIEW" && <Badge variant="destructive">needs review</Badge>}
            </div>
            {a.sensitive ? (
              <RevealSensitive activityId={a.id} />
            ) : (
              <>
                {a.subject && <div className="font-medium">{a.subject}</div>}
                {a.summary && <div className="whitespace-pre-line">{a.summary}</div>}
                {a.body && (a.summary ? (
                  <details><summary className="cursor-pointer text-xs text-muted-foreground">Full message</summary><div className="whitespace-pre-line text-muted-foreground">{a.body}</div></details>
                ) : (
                  <div className="line-clamp-6 whitespace-pre-line text-muted-foreground">{a.body}</div>
                ))}
                {a.nextSteps && a.nextSteps.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs">{a.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
                )}
                {a.transcript && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Transcript</summary>
                    <pre className="mt-1 max-h-72 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{a.transcript}</pre>
                  </details>
                )}
              </>
            )}
            {a.attachments && a.attachments.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                {a.attachments.map((f, i) =>
                  f.ownerOnly && !viewerIsOwner ? (
                    <span key={i} className="inline-flex items-center gap-1 text-muted-foreground">
                      <Paperclip className="size-3" /> {f.filename} (owner only)
                    </span>
                  ) : f.documentId ? (
                    <a key={i} href={`/api/documents/${f.documentId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Paperclip className="size-3" /> {f.filename}
                    </a>
                  ) : (
                    <a key={i} href={`/api/activities/${a.id}/attachments/${i}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Paperclip className="size-3" /> {f.filename}
                    </a>
                  ),
                )}
              </div>
            )}
            {(() => {
              const x = (a.aiClassification as { extraction?: Extraction } | null)?.extraction;
              if (a.type !== "CALL" || !x || a.sensitive) return null;
              return (
                <div className="mt-1 rounded-md bg-muted/60 p-2 text-xs">
                  <span className="font-medium">AI from the call:</span> {[x.service_code, x.address, x.urgency !== "NORMAL" && x.urgency.toLowerCase()].filter(Boolean).join(" · ") || "no service/address mentioned"}
                  {x.follow_ups.length > 0 && <span className="text-muted-foreground"> · {x.follow_ups.length} follow-up task{x.follow_ups.length > 1 ? "s" : ""}</span>}
                </div>
              );
            })()}
            {aiReplies && inbound && (a.type === "SMS" || a.type === "EMAIL_IN") && (
              <ActionForm action={draftAiReply.bind(null, a.id)} className="mt-1 flex flex-wrap items-center gap-2">
                <SubmitButton size="xs" variant="outline">Draft reply with AI</SubmitButton>
                {viewerIsOwner && (
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" name="includePricing" className="size-3.5 accent-primary" /> include the job&apos;s quote
                  </label>
                )}
              </ActionForm>
            )}
            {a.externalUrl && (
              <a className="text-xs text-primary hover:underline" href={a.externalUrl} target="_blank" rel="noreferrer">
                Open in Quo
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
