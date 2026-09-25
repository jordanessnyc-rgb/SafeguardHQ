import Link from "next/link";
import { asc, isNull, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Textarea } from "@/components/ui/textarea";
import { saveBidKeywords } from "./actions";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { Countdown } from "./countdown";

export const metadata = { title: "Bids" };

const COLUMNS = [
  { key: "WATCHING", title: "Watching" },
  { key: "GO_NO_GO", title: "Go / No-go" },
  { key: "DRAFTING", title: "Drafting" },
  { key: "SUBMITTED", title: "Submitted" },
] as const;
const CLOSED = ["AWARDED", "LOST", "NO_BID"];

export default async function BidsPage() {
  const user = await requireStaff();
  const bids = await user.db((tx) =>
    tx
      .select()
      .from(s.bids)
      .where(isNull(s.bids.archivedAt))
      .orderBy(sql`${s.bids.dueAt} asc nulls last`, asc(s.bids.createdAt)),
  );
  const closed = bids.filter((b) => CLOSED.includes(b.status)).slice(0, 30);
  const [cfg] = await user.db((tx) => tx.select({ keywords: s.settings.bidKeywords }).from(s.settings));

  return (
    <>
      <PageHeader title="Bids" description="Government solicitations — watch, decide go/no-go, draft, submit." actions={<Link href="/bids/new" className={buttonVariants()}>New bid</Link>} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((c) => {
          const items = bids.filter((b) => b.status === c.key);
          return (
            <Card key={c.key}>
              <CardHeader><CardTitle className="text-sm">{c.title} ({items.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {items.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
                {items.map((b) => (
                  <Link key={b.id} href={`/bids/${b.id}`} className="block rounded-md border p-2 text-sm hover:bg-muted/50">
                    <div className="font-medium leading-snug">{b.title}</div>
                    <div className="text-xs text-muted-foreground">{[b.agency, b.solicitationNumber].filter(Boolean).join(" · ")}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Countdown at={b.dueAt} />
                      {b.goNoGo && <Badge variant="outline">AI: {b.goNoGo.recommendation.replace("_", "-")}</Badge>}
                      {b.certGaps.length > 0 && <Badge variant="destructive">{b.certGaps.length} cert gap{b.certGaps.length > 1 ? "s" : ""}</Badge>}
                      {b.source !== "MANUAL" && <Badge variant="secondary">{b.source.replace("_", " ").toLowerCase()}</Badge>}
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm">Automatic listings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            NYC agency solicitations are pulled from the City Record (NYC Open Data) every 6 hours. NYS Contract Reporter, PASSPort and county portals don&apos;t allow automated access — sign up for their email alerts to crm@ess-nyc.com and each alert becomes a Watching bid. Listings are kept when they mention one of these keywords:
          </p>
          <ActionForm action={saveBidKeywords} className="space-y-2">
            <Textarea name="keywords" rows={2} defaultValue={cfg?.keywords.join(", ") ?? ""} disabled={user.role !== "OWNER"} aria-label="Keywords" />
            {user.role === "OWNER" && <SubmitButton size="xs" variant="secondary">Save keywords</SubmitButton>}
          </ActionForm>
        </CardContent>
      </Card>

      {closed.length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-sm">Closed</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {closed.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <Link href={`/bids/${b.id}`} className="hover:underline">{b.title}</Link>
                  <span className="text-xs text-muted-foreground">{b.status.replace("_", " ").toLowerCase()} · due {fmtDate(b.dueAt)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
