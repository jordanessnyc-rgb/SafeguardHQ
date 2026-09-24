import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { listCases } from "@/lib/airnyc/cases";
import { stagesFor } from "@/lib/pipeline/config";
import { daysInStage, isStale } from "@/lib/pipeline/rules";
import { titleCase } from "@/lib/labels";

export const metadata = { title: "AIRnyc cases" };

export default async function AirnycPage({ searchParams }: PageProps<"/airnyc">) {
  const user = await requireStaff();
  const { stage } = await searchParams;
  const { cases, stages } = await user.db(async (tx) => ({ cases: await listCases(tx, user.id), stages: await stagesFor(tx, "AIRNYC") }));
  const stageMap = new Map(stages.map((st) => [st.key, st]));
  const shown = typeof stage === "string" ? cases.filter((c) => c.stage === stage) : cases.filter((c) => !stageMap.get(c.stage)?.isTerminal);

  return (
    <>
      <PageHeader
        title="AIRnyc SCN cases"
        description="Member details are encrypted; opening this page is recorded in the audit log."
        actions={<Link href="/airnyc/new" className={buttonVariants()}>New case</Link>}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        <Link href="/airnyc" className={buttonVariants({ size: "xs", variant: typeof stage === "string" ? "ghost" : "secondary" })}>Open cases</Link>
        {stages.map((st) => {
          const n = cases.filter((c) => c.stage === st.key).length;
          return n ? (
            <Link key={st.key} href={`/airnyc?stage=${st.key}`} className={buttonVariants({ size: "xs", variant: stage === st.key ? "secondary" : "ghost" })}>
              {st.name} ({n})
            </Link>
          ) : null;
        })}
      </div>
      {shown.length === 0 ? (
        <EmptyState>No cases here.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Member</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="hidden md:table-cell">Consent (T / L)</TableHead>
              <TableHead className="text-right">Days</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((c) => {
              const st = stageMap.get(c.stage);
              const stale = !st?.isTerminal && isStale(c.stageEnteredAt, st?.staleAfterDays ?? null);
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/airnyc/${c.id}`} className="font-mono text-xs hover:underline">{c.caseId}</Link>
                    <div className="flex gap-1">
                      {c.isNycha && <Badge variant="destructive">NYCHA</Badge>}
                      {c.scopeNotCovered && <Badge variant="outline">Scope gap</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{c.memberName ?? "—"}</TableCell>
                  <TableCell><Badge variant={stale ? "destructive" : "secondary"}>{st?.name ?? c.stage}</Badge></TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{titleCase(c.tenantConsentStatus)} / {titleCase(c.landlordConsentStatus)}</TableCell>
                  <TableCell className="text-right">{daysInStage(c.stageEnteredAt)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
