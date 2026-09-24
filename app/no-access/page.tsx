export default function NoAccess() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-lg font-semibold">No access yet</h1>
        <p className="text-sm text-muted-foreground">
          You&apos;re signed in, but your account doesn&apos;t have a role. Ask Jordan to assign one in Settings → Team.
        </p>
        <form action="/auth/signout" method="post">
          <button className="text-sm text-primary underline">Sign out</button>
        </form>
      </div>
    </main>
  );
}
