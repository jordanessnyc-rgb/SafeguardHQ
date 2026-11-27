import { splitMentions, type Member } from "@/lib/team/mentions";
import { cn } from "@/lib/utils";

/** Text with @mentions highlighted (yours stronger). Keeps line breaks. */
export function MentionText({ text, members, me, className }: { text: string; members: Member[]; me?: string; className?: string }) {
  return (
    <span className={cn("whitespace-pre-line break-words", className)}>
      {splitMentions(text, members).map((p, i) =>
        "memberId" in p ? (
          <span key={i} className={cn("rounded px-0.5 font-medium text-primary", p.memberId === me ? "bg-primary/15" : "bg-primary/5")}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
