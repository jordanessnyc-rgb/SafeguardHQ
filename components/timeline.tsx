import { fmtDate, titleCase } from "@/lib/labels";

type Item = {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurredAt: Date;
  externalUrl?: string | null;
};

/** Unified activity timeline (SPEC §4.6). Phase 2 adds calls, SMS, and email to the same feed. */
export function Timeline({ items }: { items: Item[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="space-y-3 border-l pl-4">
      {items.map((a) => (
        <li key={a.id} className="relative text-sm">
          <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary" aria-hidden />
          <div className="text-xs text-muted-foreground">
            {titleCase(a.type)} · {fmtDate(a.occurredAt, true)}
          </div>
          {a.subject && <div className="font-medium">{a.subject}</div>}
          {(a.summary || a.body) && <div className="whitespace-pre-line text-muted-foreground">{a.summary ?? a.body}</div>}
          {a.externalUrl && (
            <a className="text-xs text-primary hover:underline" href={a.externalUrl} target="_blank" rel="noreferrer">
              Open source
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}
