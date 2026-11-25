import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { EmptyState, PageHeader } from "@/components/page-header";
import { TagChip } from "@/components/tag-chip";
import { requireStaff } from "@/lib/auth/session";
import { TAG_COLORS } from "@/lib/tag-style";
import { tagUsage } from "@/lib/tags";
import { deleteTagAction, saveTagAction } from "@/app/(app)/tags/actions";

export const metadata = { title: "Tags" };

const COLOR_NAMES: Record<(typeof TAG_COLORS)[number], string> = { gray: "Gray", green: "Green", blue: "Blue", amber: "Amber", red: "Red", purple: "Purple" };

function TagFields({ name, color, description }: { name?: string; color?: string; description?: string | null }) {
  return (
    <>
      <Input name="name" defaultValue={name} placeholder="Tag name" maxLength={40} required aria-label="Tag name" className="w-full sm:w-44" />
      <NativeSelect name="color" defaultValue={color ?? "gray"} aria-label="Colour" className="w-auto">
        {TAG_COLORS.map((c) => <option key={c} value={c}>{COLOR_NAMES[c]}</option>)}
      </NativeSelect>
      <Input name="description" defaultValue={description ?? ""} placeholder="What it means (optional)" maxLength={200} aria-label="Description" className="w-full sm:flex-1" />
    </>
  );
}

/** Settings → Tags: the shared list of labels used on people, companies and jobs. */
export default async function TagsSettingsPage() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const tags = await user.db((tx) => tagUsage(tx));

  const used = (n: number, noun: string, href: string) =>
    n > 0 ? <Link href={href} className="hover:underline">{n} {noun}{n === 1 ? "" : "s"}</Link> : null;

  return (
    <>
      <PageHeader
        title="Tags"
        description="Labels you can put on people, companies and jobs, then filter lists by. Tags are also what automations will trigger on. Type a new name on any record to create a tag there."
      />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>New tag</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveTagAction.bind(null, null)} className="flex flex-wrap items-center gap-2">
            <TagFields />
            <SubmitButton>Create tag</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      {tags.length === 0 ? (
        <EmptyState>No tags yet. Create one above, or add one from any person, company or job page.</EmptyState>
      ) : (
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>{tags.length} tag{tags.length === 1 ? "" : "s"}</CardTitle>
            <CardDescription>Renaming a tag changes it everywhere it&apos;s used.{isOwner ? " Deleting one removes it from every record." : ""}</CardDescription>
          </CardHeader>
          <ul className="divide-y">
            {tags.map((t) => {
              const usage = [
                used(t.contacts, "person", `/contacts?tag=${t.id}`),
                used(t.organizations, "company", `/organizations?tag=${t.id}`),
                used(t.jobs, "job", `/jobs?view=list&status=all&tag=${t.id}`),
              ].filter(Boolean);
              return (
                <li key={t.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <TagChip tag={t} />
                    {usage.length ? usage.map((u, i) => <span key={i}>{u}</span>) : <span>Not used yet</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionForm action={saveTagAction.bind(null, t.id)} className="flex flex-1 flex-wrap items-center gap-2">
                      <TagFields name={t.name} color={t.color} description={t.description} />
                      <SubmitButton variant="outline" size="sm">Save</SubmitButton>
                    </ActionForm>
                    {isOwner && (
                      <form action={deleteTagAction.bind(null, t.id)}>
                        <ConfirmSubmit
                          title={`Delete the “${t.name}” tag?`}
                          description={`It comes off ${[t.contacts && `${t.contacts} people`, t.organizations && `${t.organizations} companies`, t.jobs && `${t.jobs} jobs`].filter(Boolean).join(", ") || "nothing (it isn't used)"}. This can't be undone.`}
                          confirmLabel="Delete tag"
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                        >
                          Delete
                        </ConfirmSubmit>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
