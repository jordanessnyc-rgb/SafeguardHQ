import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CodeForm, EnrollTotp } from "./totp";

export const metadata = { title: "Two-step sign-in · ESS CRM" };

export default async function MfaPage({ searchParams }: PageProps<"/mfa">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.mfaPending) redirect(next);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = data?.totp[0];

  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-block size-3 rounded-full bg-primary" aria-hidden />
            <span className="text-sm font-semibold tracking-wide text-primary">Environmental Safeguard Solutions</span>
          </div>
          <CardTitle>Two-step sign-in</CardTitle>
          <CardDescription>
            {factor
              ? "Enter the code from your authenticator app to finish signing in."
              : "The owner account can see pricing and invoices, so it needs a second step: a code from an app on your phone. This takes a minute, once."}
          </CardDescription>
        </CardHeader>
        <CardContent>{factor ? <CodeForm factorId={factor.id} next={next} /> : <EnrollTotp next={next} />}</CardContent>
      </Card>
    </main>
  );
}
