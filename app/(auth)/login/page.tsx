import Image from "next/image";
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
          <Image src="/ess-logo.png" alt="Environmental Safeguard Solutions" width={280} height={126} priority className="mx-auto mb-3 h-auto w-64" />
          <CardTitle>Sign in to ESS CRM</CardTitle>
          <CardDescription>Sign in with your email and password.</CardDescription>
        </CardHeader>
        <CardContent>
          {failed && (
            <p className="mb-3 text-sm text-destructive">That link expired or was already used. Use &ldquo;Forgot password?&rdquo; to get a new one.</p>
          )}
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
