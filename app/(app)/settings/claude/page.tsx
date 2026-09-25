import Link from "next/link";
import { headers } from "next/headers";
import { desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { siteOrigin } from "@/lib/site";
import { createToken, revokeToken } from "./actions";
import { NewTokenForm } from "./new-token";

export const metadata = { title: "Claude access" };

export default async function ClaudeSettingsPage() {
  const user = await requireStaff();
  const tokens = await user.db((tx) => tx.select().from(s.mcpTokens).orderBy(desc(s.mcpTokens.createdAt))); // RLS: your own tokens
  const endpoint = `${siteOrigin(await headers())}/api/mcp`;

  return (
    <>
      <PageHeader title="Claude access" description={<Link href="/settings" className="hover:underline">← Settings</Link>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connect Claude to the CRM</CardTitle>
            <CardDescription>
              Lets Claude (Claude Code or a claude.ai custom connector) look things up in the CRM: jobs, contacts, open violations, tasks and the pipeline. Read-only — Claude can’t change or send anything.
              It sees only what you can see ({user.role === "OWNER" ? "including money" : "no pricing or invoices"}), and never AIRnyc member data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              Server URL: <code className="rounded bg-muted px-1 text-xs">{endpoint}</code>
            </div>
            <NewTokenForm action={createToken} endpoint={endpoint} />
            <p className="text-xs text-muted-foreground">
              claude.ai: Settings → Connectors → Add custom connector, enter the server URL and add an <code>Authorization: Bearer …</code> header with your token.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your tokens</CardTitle>
            <CardDescription>Revoke a token if a device is lost or you no longer use it. Revoking takes effect immediately.</CardDescription>
          </CardHeader>
          <CardContent>
            {tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tokens yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {tokens.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{t.label}</span>{" "}
                      {t.revokedAt ? <Badge variant="outline">revoked</Badge> : <Badge variant="secondary">active</Badge>}
                      <span className="block text-xs text-muted-foreground">
                        Created {fmtDate(t.createdAt, true)} · {t.lastUsedAt ? `last used ${fmtDate(t.lastUsedAt, true)}` : "never used"}
                      </span>
                    </span>
                    {!t.revokedAt && (
                      <form action={revokeToken.bind(null, t.id)}>
                        <Button size="xs" variant="ghost" type="submit">Revoke</Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
