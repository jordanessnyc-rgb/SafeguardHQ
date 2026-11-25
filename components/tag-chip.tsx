import type { ReactNode } from "react";
import { TAG_COLOR_CLASS, type Tag } from "@/lib/tag-style";
import { cn } from "@/lib/utils";

/** A coloured tag label. `children` (e.g. a remove button) sits after the name. */
export function TagChip({ tag, className, children }: { tag: Pick<Tag, "name" | "color">; className?: string; children?: ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 max-w-full items-center gap-1 rounded-full px-2 text-xs font-medium ring-1", TAG_COLOR_CLASS[tag.color] ?? TAG_COLOR_CLASS.gray, className)}>
      <span className="truncate">{tag.name}</span>
      {children}
    </span>
  );
}

/** A row of tag chips for list rows; renders nothing when there are none. */
export function TagRow({ tags, className }: { tags: Pick<Tag, "id" | "name" | "color">[] | undefined; className?: string }) {
  if (!tags?.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {tags.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
    </span>
  );
}
