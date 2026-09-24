import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { TaskList } from "@/components/task-list";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { BidFields } from "../bid-fields";
import { Countdown } from "../countdown";
import { decideBid, setBidStatus, updateBid, uploadRfp } from "../actions";

const STATUS_LABELS: Record<string, string> = { WATCHING: "Watching", GO_NO_GO: "Go / No-go", DRAFTING: "Drafting", SUBMITTED: "Submitted", AWARDED: "Awarded", LOST: "Lost", NO_BID: "No bid" };
const MARK: Record<string, string> = { MET: "✓", GAP: "✗", UNKNOWN: "?" };

export default async function BidPage({ params }: PageProps<"/bids/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const d = await user.db(async (tx) => {
    const [bid] = await tx.select().from(s.bids).where(eq(s.bids.id, id));
    if (!bid) return null;
    return {
      bid,
      docs: await tx.select().from(s.documents).where(and(eq(s.documents.bidId, id), isNull(s.documents.archivedAt))).orderBy(desc(s.documents.createdAt)),
      tasks: await tx.select().from(s.tasks).where(and(eq(s.tasks.bidId, id), isNull(s.tasks.archivedAt))).orderBy(asc(s.tasks.status), asc(s.tasks.dueAt)),
    };
  });
  if (!d) notFound();
  const { bid, docs, tasks } = d;
  const g = bid.goNoGo;

  return (
    <>
      <PageHeader
        title={bid.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/bids" className="hover:underline">← Bids</Link>
            <span>· {[bid.agency, bid.solicitationNumber, bid.type].filter(Boolean).join(" · ")}</span>
            <Badge variant="secondary">{STATUS_LABELS[bid.status]}</Badge>
            <Countdown at={bid.dueAt} />
            {bid.sourceUrl && <a href={bid.sourceUrl} target="_blank" rel="noreferrer" className="underline">listing</a>}
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Go / no-go</CardTitle>
            <CardDescription>Upload the solicitation PDF: the AI extracts deadlines, required certifications, insurance and scope, and checks them against ESS&apos;s licenses (Compliance page). It only recommends — the decision is Jordan&apos;s.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionForm action={uploadRfp.bind(null, id)} className="flex flex-wrap items-center gap-2">
              <Input name="rfp" type="file" accept="application/pdf" className="max-w-xs" aria-label="Solicitation PDF" />
              <SubmitButton size="sm" variant="secondary">Upload &amp; analyze</SubmitButton>
            </ActionForm>
            {g ? (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={g.recommendation === "GO" ? "default" : g.recommendation === "NO_GO" ? "destructive" : "secondary"}>AI: {g.recommendation.replace("_", "-")}</Badge>
                  <span>{g.summary}</span>
                </div>
                <ul className="space-y-1">
                  {g.checklist.map((c, i) => (
                    <li key={i} className={c.status === "GAP" ? "text-destructive" : c.status === "UNKNOWN" ? "text-amber-700 dark:text-amber-400" : ""}>
                      <span className="inline-block w-5 font-mono">{MARK[c.status]}</span>
                      <span className="font-medium">{c.item}</span> <span className="text-muted-foreground">— {c.note}</span>
                    </li>
                  ))}
                </ul>
                {bid.requiredCerts.length > 0 && <p><span className="font-medium">Required certifications:</span> {bid.requiredCerts.join("; ")}</p>}
                {g.submission.length > 0 && (
                  <div>
                    <div className="font-medium">To submit</div>
                    <ul className="list-disc pl-5">{g.submission.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Analyzed {fmtDate(g.at, true)} · {g.model}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No analysis yet.</p>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              {bid.decision ? (
                <span className="text-sm">
                  Decision: <strong>{bid.decision === "GO" ? "Go" : "No-go"}</strong> · {fmtDate(bid.decidedAt, true)}
                </span>
              ) : isOwner ? (
                <>
                  <form action={decideBid.bind(null, id, "GO")}><Button size="sm" type="submit">Go — start drafting</Button></form>
                  <form action={decideBid.bind(null, id, "NO_GO")}><Button size="sm" variant="outline" type="submit">No-go</Button></form>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Waiting on Jordan&apos;s go/no-go.</span>
              )}
              <form action={setBidStatus.bind(null, id)} className="ml-auto flex items-center gap-1">
                <NativeSelect name="status" defaultValue={bid.status} className="h-8 w-40" aria-label="Status">
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </NativeSelect>
                <Button size="sm" variant="ghost" type="submit">Set status</Button>
              </form>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Deadlines</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {[["Questions", bid.questionsDue], ["Site visit", bid.siteVisitAt], ["Due", bid.dueAt], ["Opening", bid.openingAt]].map(([label, at]) => (
                <div key={label as string} className="flex items-center justify-between gap-2">
                  <span>{label as string}</span>
                  <span className="text-right">{at ? fmtDate(at as Date, true) : "—"}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Documents</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {docs.length === 0 && <p className="text-muted-foreground">None.</p>}
              {docs.map((x) => <a key={x.id} href={`/api/documents/${x.id}`} target="_blank" rel="noreferrer" className="block hover:underline">{x.title ?? "Document"}</a>)}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
            <CardContent><TaskList tasks={tasks} link={{ bidId: id }} revalidate={`/bids/${id}`} /></CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-4 max-w-3xl">
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updateBid.bind(null, id)} className="space-y-4">
            <BidFields bid={bid} />
            <SubmitButton size="sm">Save</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
