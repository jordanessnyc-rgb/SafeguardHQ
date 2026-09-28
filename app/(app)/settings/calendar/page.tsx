import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { requireOwner } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { titanCalendarFromEnv, type CalendarInfo } from "@/lib/integrations/titan-calendar";
import { saveCalendarSettings } from "./actions";

export const metadata = { title: "Titan calendar" };

export default async function CalendarSettingsPage() {
  const user = await requireOwner();
  const [cfg] = await user.db((tx) => tx.select({ writeUrl: s.settings.calendarWriteUrl, hidden: s.settings.calendarHiddenUrls }).from(s.settings));
  const titan = titanCalendarFromEnv();
  let calendars: CalendarInfo[] = [];
  let error: string | null = null;
  let writeUrl = cfg?.writeUrl ?? null;
  if (titan) {
    try {
      calendars = await titan.listCalendars();
      writeUrl ??= await titan.calendarUrl();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const hidden = new Set(cfg?.hidden ?? []);

  return (
    <>
      <PageHeader title="Titan calendar" description="Your Titan calendars show on the CRM schedule next to CRM visits, and every visit booked in the CRM is copied to one of them." />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection {titan && !error ? <Status tone="ok">Connected</Status> : <Status tone="error">Not connected</Status>}
          </CardTitle>
          <CardDescription>
            Reading is live: events you add or change in Titan show up the next time the schedule loads. The CRM never changes or deletes your own Titan events; it only adds, moves and removes the
            visits it booked. No invitations are sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!titan ? (
            <p className="text-sm text-muted-foreground">The server doesn&apos;t have the Titan calendar turned on (TITAN_CALDAV_ENABLED).</p>
          ) : error ? (
            <p className="text-sm text-destructive">Couldn&apos;t reach Titan: {error}</p>
          ) : (
            <ActionForm action={saveCalendarSettings} className="space-y-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-medium">Calendar</th>
                    <th className="w-32 py-1.5 text-center font-medium">Show on schedule</th>
                    <th className="w-36 py-1.5 text-center font-medium">CRM visits go here</th>
                  </tr>
                </thead>
                <tbody>
                  {calendars.map((c) => (
                    <tr key={c.url} className="border-b last:border-0">
                      <td className="py-2">
                        <span className="mr-2 inline-block size-3 rounded-sm align-middle" style={{ background: c.color ?? "#999" }} aria-hidden />
                        {c.name}
                      </td>
                      <td className="py-2 text-center">
                        <input type="checkbox" name="show" value={c.url} defaultChecked={!hidden.has(c.url)} className="size-4 accent-primary" aria-label={`Show ${c.name} on the schedule`} />
                      </td>
                      <td className="py-2 text-center">
                        <input type="radio" name="writeUrl" value={c.url} defaultChecked={c.url === writeUrl} className="size-4 accent-primary" aria-label={`Put CRM visits in ${c.name}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
