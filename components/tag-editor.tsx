"use client";

import { useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { TagChip } from "@/components/tag-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionState } from "@/lib/actions";
import type { Tag } from "@/lib/tag-style";

/**
 * The tags on one record (contact, company or job) with remove buttons, plus an "Add tag" field that
 * suggests existing tags as you type. Typing a new name creates the tag.
 */
export function TagEditor({
  tags,
  allTags,
  add,
  remove,
}: {
  tags: Tag[];
  allTags: Tag[];
  /** addTagAction bound to the record. */
  add: (prev: ActionState, form: FormData) => Promise<ActionState>;
  /** removeTagAction bound to the record; takes the tag id. */
  remove: (tagId: string) => Promise<void>;
}) {
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const have = new Set(tags.map((t) => t.id));
  const suggestions = allTags.filter((t) => !have.has(t.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
      {tags.map((t) => (
        <TagChip key={t.id} tag={t}>
          <form action={remove.bind(null, t.id)} className="contents">
            <button type="submit" className="-mr-1 rounded-full p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={`Remove tag ${t.name}`}>
              <X className="size-3" />
            </button>
          </form>
        </TagChip>
      ))}
      {adding ? (
        <ActionForm
          action={add}
          className="flex items-center gap-1.5"
          onSuccess={() => {
            if (input.current) input.current.value = "";
            setAdding(false);
          }}
        >
          <Input ref={input} name="name" list={listId} placeholder="Tag name" autoFocus maxLength={40} required className="h-7 w-40 text-xs" aria-label="Tag name" autoComplete="off" />
          <datalist id={listId}>
            {suggestions.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
          <SubmitButton size="xs">Add</SubmitButton>
          <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </ActionForm>
      ) : (
        <Button type="button" size="xs" variant="outline" onClick={() => setAdding(true)} className="h-6 rounded-full text-xs">
          <Plus /> {tags.length ? "Tag" : "Add tag"}
        </Button>
      )}
    </div>
  );
}
