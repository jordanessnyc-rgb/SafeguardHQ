import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createTask, setTaskStatus } from "@/app/(app)/tasks/actions";
import { fmtDate } from "@/lib/labels";
import { cn } from "@/lib/utils";

type Task = { id: string; title: string; description: string | null; dueAt: Date | null; status: string; source: string };

/** Compact task list + quick-add, embedded on job / property / contact / case pages. */
export function TaskList({
  tasks,
  link,
  revalidate,
}: {
  tasks: Task[];
  link: Partial<Record<"jobId" | "contactId" | "propertyId" | "airnycCaseId", string>>;
  revalidate: string;
}) {
  // Server Component: rendered once per request, so reading the clock here is deterministic enough.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  return (
    <div className="space-y-2">
      {tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks.</p>}
      {tasks.map((t) => {
        const done = t.status === "DONE" || t.status === "CANCELED";
        const overdue = !done && t.dueAt && t.dueAt.getTime() < now;
        return (
          <div key={t.id} className="flex items-start gap-2 text-sm">
            <form action={setTaskStatus.bind(null, t.id, done ? "OPEN" : "DONE", revalidate)}>
              <Button size="icon-xs" variant="outline" type="submit" aria-label={done ? "Reopen" : "Mark done"}>
                {done ? <RotateCcw /> : <Check />}
              </Button>
            </form>
            <div className={cn("min-w-0 flex-1", done && "text-muted-foreground line-through")}>
              <div>{t.title}</div>
              {t.description && <div className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{t.description}</div>}
              <div className={cn("text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
                {t.dueAt ? `Due ${fmtDate(t.dueAt)}` : "No due date"}
                {t.source !== "MANUAL" && ` · ${t.source.replace(/_/g, " ").toLowerCase()}`}
              </div>
            </div>
          </div>
        );
      })}
      <ActionForm action={createTask} className="flex flex-wrap gap-2 border-t pt-3">
        {Object.entries(link).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <input type="hidden" name="revalidate" value={revalidate} />
        <Input name="title" placeholder="New task…" className="min-w-40 flex-1" required />
        <Input name="dueAt" type="date" className="w-36" aria-label="Due date" />
        <SubmitButton size="sm" variant="secondary">Add</SubmitButton>
      </ActionForm>
    </div>
  );
}
