import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { adminDb } from "@/lib/db";
import { naturalLanguageSearch } from "@/lib/search/run";

export const metadata = { title: "Ask the CRM" };

const EXAMPLES = [
  "Which management companies haven't paid in 60 days?",
  "LL152 jobs scheduled next week",
  "Open HPD class C violations at properties we have active jobs on",
  "How many new leads per month this year?",
];

const cell = (v: unknown) => (v == null ? "—" : v instanceof Date ? v.toLocaleString("en-US", { timeZone: "America/New_York" }) : Array.isArray(v) ? v.join(", ") : String(v));

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 500) : "";
  const aiReady = Boolean(process.env.ANTHROPIC_API_KEY);
  const result = q && aiReady ? await naturalLanguageSearch(adminDb(), user, q) : null;

  return (
    <>
      <PageHeader title="Ask the CRM" description="Plain-English questions → a read-only query that only sees what you're allowed to see. The AI writes the query; it never sees your data." />
      <form className="mb-4 flex flex-wrap gap-2">
        <Input name="q" defaultValue={q} placeholder="e.g. Which management companies haven't paid in 60 days?" className="max-w-2xl flex-1" />
        <Button type="submit" disabled={!aiReady}>Ask</Button>
      </form>
      {!aiReady && <p className="text-sm text-muted-foreground">Needs ANTHROPIC_API_KEY.</p>}
      {!q && (
        <div className="flex flex-wrap gap-2 text-sm">
          {EXAMPLES.map((e) => (
            <a key={e} href={`/search?q=${encodeURIComponent(e)}`} className="rounded-full border px-3 py-1 hover:bg-muted">{e}</a>
          ))}
        </div>
      )}
      {result && result.status !== "ok" && (
        <Card>
          <CardContent className="pt-6 text-sm">
            <p className={result.status === "error" ? "text-destructive" : ""}>{result.reason}</p>
            {result.sql && <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">{result.sql}</pre>}
          </CardContent>
        </Card>
      )}
      {result?.status === "ok" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{result.explanation}</CardTitle>
            <CardDescription>
              {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
              {result.rows.length === 200 && " (first 200)"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.rows.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>{result.columns.map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r, i) => (
                    <TableRow key={i}>{result.columns.map((c) => <TableCell key={c} className="whitespace-normal">{cell(r[c])}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No matching records.</p>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Query</summary>
              <pre className="mt-1 overflow-auto rounded bg-muted p-2">{result.sql}</pre>
            </details>
          </CardContent>
        </Card>
      )}
    </>
  );
}
