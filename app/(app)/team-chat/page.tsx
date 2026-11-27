import Link from "next/link";
import { AtSign, Trash2, UserRoundCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/page-header";
import { MentionComposer } from "@/components/team/mention-composer";
import { MentionText } from "@/components/team/mention-text";
import { requireStaff } from "@/lib/auth/session";
import { fmtDate } from "@/lib/labels";
import { markChatRead, markNotificationsRead, myNotifications, recentTeamMessages, teamMembers } from "@/lib/team/inbox";
import { cn } from "@/lib/utils";
import { deleteTeamMessageAction, markAllReadAction, postTeamMessageAction } from "./actions";
import { AutoRefresh } from "./auto-refresh";

export const metadata = { title: "Team chat" };

/**
 * Internal team chat: a room for the office team (owner + VAs) and the list of times someone
 * mentioned you or assigned you a conversation. Nothing here is ever sent to a client or lead.
 */
export default async function TeamChatPage() {
  const user = await requireStaff();
  const { members, messages, notes } = await user.db(async (tx) => {
    const data = { members: await teamMembers(tx), messages: await recentTeamMessages(tx), notes: await myNotifications(tx, user.id) };
    // Opening the page reads the room and your notifications (the list below still shows which were new).
    await markChatRead(tx, user.id);
    await markNotificationsRead(tx, user.id);
    return data;
  });
  const name = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Someone";
  const isOwner = user.role === "OWNER";
  const lastId = messages.at(-1)?.id;

  return (
    <>
      <AutoRefresh scrollTo={lastId ? `m-${lastId}` : undefined} />
      <PageHeader title="Team chat" description="Talk with the team. Only staff can see this page; nothing here is ever sent to a client or lead. Type @ and a name to notify someone." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>Everyone</CardTitle>
            <CardDescription>{members.map((m) => m.name).join(", ")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            {messages.length === 0 ? (
              <EmptyState>No messages yet. Say hello to the team.</EmptyState>
            ) : (
              <ol className="max-h-[60dvh] space-y-3 overflow-y-auto pr-1">
                {messages.map((m) => {
                  const mine = m.authorId === user.id;
                  return (
                    <li key={m.id} id={`m-${m.id}`} className="group flex scroll-mt-24 gap-2.5">
                      <span aria-hidden className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", mine ? "bg-primary" : "bg-(--brand-sage)")}>
                        {name(m.authorId).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <span className="font-semibold">{mine ? "You" : name(m.authorId)}</span>
                          <time dateTime={m.createdAt.toISOString()} className="text-muted-foreground">{fmtDate(m.createdAt, true)}</time>
                          {(mine || isOwner) && (
                            <form action={deleteTeamMessageAction.bind(null, m.id)} className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <Button type="submit" variant="ghost" size="xs" aria-label="Delete this message">
                                <Trash2 />
                              </Button>
                            </form>
                          )}
                        </div>
                        <MentionText text={m.body} members={members} me={user.id} className="text-sm" />
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <MentionComposer action={postTeamMessageAction} members={members} me={user.id} placeholder="Message the team…" submitLabel="Send" hint="Ctrl/⌘ + Enter to send. Updates every 20 seconds while this page is open." />
          </CardContent>
        </Card>

        <Card className="h-fit gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between border-b py-4">
            <div>
              <CardTitle>For you</CardTitle>
              <CardDescription>Mentions and conversations assigned to you</CardDescription>
            </div>
            {notes.some((n) => !n.readAt) && (
              <form action={markAllReadAction}>
                <Button type="submit" variant="ghost" size="xs">Mark read</Button>
              </form>
            )}
          </CardHeader>
          <CardContent className="px-0">
            {notes.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nothing yet. When someone @mentions you or assigns you a conversation, it shows here.</p>
            ) : (
              <ul className="divide-y">
                {notes.map((n) => {
                  const Icon = n.kind === "ASSIGNED" ? UserRoundCheck : AtSign;
                  const inner = (
                    <>
                      <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-sm", !n.readAt && "font-semibold")}>
                          {n.title}
                          {!n.readAt && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" aria-label="new" />}
                        </span>
                        {n.body && <MentionText text={n.body} members={members} me={user.id} className="line-clamp-2 block text-xs text-muted-foreground" />}
                        <span className="block text-[11px] text-muted-foreground">{fmtDate(n.createdAt, true)}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={n.id}>
                      {n.href ? (
                        <Link href={n.href} className="flex gap-2.5 px-4 py-3 hover:bg-muted/50">{inner}</Link>
                      ) : (
                        <div className="flex gap-2.5 px-4 py-3">{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
