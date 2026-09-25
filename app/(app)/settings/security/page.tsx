import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { fmtDate } from "@/lib/labels";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { removeFactor } from "@/app/(auth)/mfa/actions";
import { EnrollTotp } from "@/app/(auth)/mfa/totp";

export const metadata = { title: "Sign-in security" };

export default async function SecurityPage() {
  await requireOwner();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factors = data?.totp ?? [];
  const canRemove = factors.length > 1; // the owner must always keep one

  return (
    <>
      <PageHeader title="Sign-in security" description={<Link href="/settings" className="hover:underline">← Settings</Link>} />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Two-step sign-in</CardTitle>
          <CardDescription>
            Required for the owner account. Add a second authenticator (another phone, or a password manager) so a lost phone doesn&apos;t lock you out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {factors.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not turned on.</p>
          ) : (
            <ul className="divide-y text-sm">
              {factors.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    {f.friendly_name ?? "Authenticator app"}
                    <span className="block text-xs text-muted-foreground">Added {fmtDate(new Date(f.created_at), true)}</span>
                  </span>
                  {canRemove && (
                    <form action={removeFactor.bind(null, f.id)}>
                      <Button size="xs" variant="ghost" type="submit">Remove</Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          <EnrollTotp />
        </CardContent>
      </Card>
    </>
  );
}
