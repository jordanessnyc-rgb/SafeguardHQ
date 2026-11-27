/**
 * @mentions in internal notes and team chat. Pure functions (no server imports) so the composer and
 * the server agree. A mention is "@" + a member's full name or first name, case-insensitive:
 * "@Maria Lopez" or "@maria". Full names win over first names; a first name shared by two members
 * only matches with the full name.
 */
export type Member = { id: string; name: string };

type Candidate = { id: string; label: string };

function candidates(members: Member[]): Candidate[] {
  const firsts = new Map<string, number>();
  for (const m of members) {
    const first = m.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const out: Candidate[] = [];
  for (const m of members) {
    const full = m.name.trim().replace(/\s+/g, " ");
    if (!full) continue;
    out.push({ id: m.id, label: full });
    const first = full.split(" ")[0];
    if (first !== full && firsts.get(first.toLowerCase()) === 1) out.push({ id: m.id, label: first });
  }
  // Longest label first, so "@Maria Lopez" isn't read as "@Maria" + " Lopez".
  return out.sort((a, b) => b.label.length - a.label.length);
}

const boundary = (ch: string | undefined) => ch === undefined || !/[\p{L}\p{N}_]/u.test(ch);

/** Splits text into plain runs and mentions (for rendering). */
export function splitMentions(text: string, members: Member[]): ({ text: string } | { text: string; memberId: string })[] {
  const cands = candidates(members);
  const parts: ({ text: string } | { text: string; memberId: string })[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && boundary(text[i - 1])) {
      const rest = text.slice(i + 1);
      const hit = cands.find((c) => rest.slice(0, c.label.length).toLowerCase() === c.label.toLowerCase() && boundary(rest[c.label.length]));
      if (hit) {
        if (plain) parts.push({ text: plain });
        plain = "";
        parts.push({ text: `@${rest.slice(0, hit.label.length)}`, memberId: hit.id });
        i += hit.label.length + 1;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

/** The members mentioned in `text`, once each, excluding `authorId` (you don't notify yourself). */
export function mentionedIds(text: string, members: Member[], authorId?: string | null): string[] {
  const ids = splitMentions(text, members).flatMap((p) => ("memberId" in p ? [p.memberId] : []));
  return [...new Set(ids)].filter((id) => id !== authorId);
}
