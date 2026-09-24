import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · ESS CRM" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/";
  const failed = sp.error === "link";
  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-block size-3 rounded-full bg-primary" aria-hidden />
            <span className="text-sm font-semibold tracking-wide text-primary">Environmental Safeguard Solutions</span>
          </div>
          <CardTitle>Sign in to ESS CRM</CardTitle>
          <CardDescription>We&apos;ll email you a one-time sign-in link.</CardDescription>
        </CardHeader>
        <CardContent>
          {failed && (
            <p className="mb-3 text-sm text-destructive">That sign-in link expired or was already used. Request a new one.</p>
          )}
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
