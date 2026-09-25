import { Badge } from "@/components/ui/badge";
import { countdown } from "@/lib/time";

/** "due in 3d" style countdown; urgent (≤7 days) and overdue stand out (SPEC §8). */
export function Countdown({ at, label = "due" }: { at: Date | null; label?: string }) {
  if (!at) return <Badge variant="outline">no date</Badge>;
  const c = countdown(at, label);
  return <Badge variant={c.past ? "destructive" : c.urgent ? "default" : "secondary"}>{c.text}</Badge>;
}
