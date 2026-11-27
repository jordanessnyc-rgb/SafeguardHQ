/** Tag colours and types, kept free of server imports so client components (the tag editor) can use them. */
export const TAG_COLORS = ["gray", "green", "blue", "amber", "red", "purple"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export type Tag = { id: string; name: string; color: TagColor };

export function isTagColor(v: unknown): v is TagColor {
  return (TAG_COLORS as readonly unknown[]).includes(v);
}

/** Chip colours: muted pairs that read in light and dark, like the dashboard kind labels. */
export const TAG_COLOR_CLASS: Record<TagColor, string> = {
  gray: "bg-muted text-foreground ring-black/[0.08] dark:ring-white/10",
  green: "bg-sidebar-accent text-sidebar-primary ring-primary/20",
  blue: "bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900",
  amber: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900",
  red: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900",
  purple: "bg-purple-50 text-purple-900 ring-purple-200 dark:bg-purple-950 dark:text-purple-200 dark:ring-purple-900",
};
