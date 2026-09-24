import { requireSub } from "@/lib/auth/session";

export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const user = await requireSub();
  return (
    <div className="min-h-svh">
      <header className="border-b bg-sidebar">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-primary">Environmental Safeguard Solutions</div>
            <div className="text-xs text-muted-foreground">Subcontractor portal</div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{user.fullName ?? user.email}</div>
            <form action="/auth/signout" method="post"><button className="underline hover:text-foreground">Sign out</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl p-4 md:p-6">{children}</main>
    </div>
  );
}
