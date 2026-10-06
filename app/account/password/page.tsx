import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Password · ESS CRM" };

/** Set or change your own password. Also where a "Forgot password" email link lands. */
export default async function PasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/password");
  const home = user.role === "SUB" ? "/portal" : "/";
  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set your password</CardTitle>
          <CardDescription>
            Signed in as {user.email}. You&apos;ll sign in with this email and password from now on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm home={home} />
        </CardContent>
      </Card>
    </main>
  );
}
