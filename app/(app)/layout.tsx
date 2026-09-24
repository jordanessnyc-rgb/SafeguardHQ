import { MobileNav, SideNav } from "@/components/app-nav";
import { requireStaff } from "@/lib/auth/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireStaff();
  const identity = (
    <div className="text-xs text-muted-foreground">
      <div className="truncate font-medium text-foreground">{user.fullName ?? user.email}</div>
      <div>{user.role === "OWNER" ? "Owner" : "VA"}</div>
      <form action="/auth/signout" method="post" className="mt-1">
        <button className="underline hover:text-foreground">Sign out</button>
      </form>
    </div>
  );
  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-56 shrink-0 flex-col justify-between border-r bg-sidebar p-3 md:flex">
        <div className="space-y-4">
          <div className="px-2.5 pt-1">
            <div className="text-sm font-semibold text-primary">ESS CRM</div>
            <div className="text-xs text-muted-foreground">Environmental Safeguard Solutions</div>
          </div>
          <SideNav isOwner={user.role === "OWNER"} />
        </div>
        <div className="px-2.5">{identity}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b bg-sidebar px-4 pt-3 md:hidden">
          <div className="mb-2 flex items-start justify-between">
            <span className="text-sm font-semibold text-primary">ESS CRM</span>
            {identity}
          </div>
          <MobileNav isOwner={user.role === "OWNER"} />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
