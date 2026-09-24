/**
 * Sub copy generator (SPEC §10). From a report DOCX, produce the version a subcontractor may see:
 * pricing, funding references, signature blocks and consent forms removed; in-scope work and
 * work-area photos kept. Then validate the result by scanning its text for "$", price, cost,
 * invoice, funding — anything left blocks release, and a human fixes the report.
 *
 * Works on the WordprocessingML directly: whole sections under a banned heading are dropped
 * (until the next heading of the same or higher level), then single paragraphs / table rows that
 * mention money. Removing too much is the safe failure; the removed text is reported for review.
 */
import PizZip from "pizzip";
import { docxText } from "./render";

/** SPEC §10 validation terms. */
export const SUB_COPY_FORBIDDEN = /\$|\bpric(?:e|es|ed|ing)\b|\bcosts?\b|\binvoic(?:e|es|ed|ing)\b|\bfunding\b/i;
const BANNED_HEADING = /pric(?:e|es|ing)|\bfees?\b|\bcosts?\b|invoic|payment|billing|\bfund(?:ing|ed|s)?\b|budget|signature|sign-?off|consent|authori[sz]|\bterms\b|acceptance|quote|estimate/i;
const BANNED_LINE = new RegExp(`${SUB_COPY_FORBIDDEN.source}|\\b\\d[\\d,]*\\.\\d{2}\\b|\\bfees?\\b|\\bpayment\\b|\\bdeposit\\b|\\bmedicaid\\b|\\bSCN\\b|\\bsignature\\b|\\bsigned\\b|_{5,}|\\bconsent\\b`, "i");

type El = { xml: string; kind: "p" | "tbl" | "other"; text: string; level: number | null };

/** Text of an element; paragraphs (e.g. table cells) are space-separated so word boundaries hold. */
const textOf = (xml: string) =>
  xml
    .split("</w:p>")
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
    .filter(Boolean)
    .join(" ");

function headingLevel(xml: string): number | null {
  const style = xml.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
  if (/^Title$/i.test(style)) return 0;
  const m = style.match(/^Heading(\d)$/i);
  return m ? Number(m[1]) : null;
}

/** End index of the element named `tag` starting at `start`, honoring nesting of the same tag. */
function endOf(xml: string, start: number, tag: string): number {
  const open = new RegExp(`<${tag}(?=[\\s>/])`, "g");
  const close = `</${tag}>`;
  let depth = 0;
  let i = start;
  for (;;) {
    open.lastIndex = i;
    const o = open.exec(xml);
    const c = xml.indexOf(close, i);
    if (o && (c === -1 || o.index < c)) {
      const tagEnd = xml.indexOf(">", o.index);
      if (xml[tagEnd - 1] === "/") {
        if (depth === 0) return tagEnd + 1; // self-closing at top level
      } else depth++;
      i = tagEnd + 1;
    } else {
      if (c === -1) return xml.length;
      depth--;
      i = c + close.length;
      if (depth === 0) return i;
    }
  }
}

function splitBody(body: string): El[] {
  const out: El[] = [];
  let i = 0;
  while (i < body.length) {
    const next = body.slice(i).search(/<w:(p|tbl|sectPr|bookmarkStart|bookmarkEnd|sdt)(?=[\s>/])/);
    if (next === -1) {
      out.push({ xml: body.slice(i), kind: "other", text: "", level: null });
      break;
    }
    if (next > 0) out.push({ xml: body.slice(i, i + next), kind: "other", text: "", level: null });
    const at = i + next;
    const tag = body.slice(at + 1).match(/^w:(\w+)/)![0];
    const end = endOf(body, at, tag);
    const xml = body.slice(at, end);
    const kind = tag === "w:p" ? "p" : tag === "w:tbl" ? "tbl" : "other";
    out.push({ xml, kind, text: kind === "other" && tag !== "w:sdt" ? "" : textOf(xml), level: kind === "p" ? headingLevel(xml) : null });
    i = end;
  }
  return out;
}

function filterTable(xml: string, removed: string[]): string | null {
  const rows = [...xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
  if (!rows.length) return xml;
  if (BANNED_LINE.test(textOf(rows[0]))) {
    removed.push(`[table] ${textOf(rows[0])}`);
    return null; // a pricing/fee table: drop it whole
  }
  let out = xml;
  for (const r of rows.slice(1)) {
    const t = textOf(r);
    if (BANNED_LINE.test(t)) {
      removed.push(`[row] ${t}`);
      out = out.replace(r, "");
    }
  }
  return out;
}

export type SubCopyResult = { buffer: Buffer; removed: string[]; violations: string[] };

export function makeSubCopy(report: Buffer): SubCopyResult {
  const zip = new PizZip(report);
  const removed: string[] = [];

  const docXml = zip.file("word/document.xml")!.asText();
  const bodyStart = docXml.indexOf(">", docXml.indexOf("<w:body")) + 1;
  const bodyEnd = docXml.lastIndexOf("</w:body>");
  const els = splitBody(docXml.slice(bodyStart, bodyEnd));
  const kept: string[] = [];
  let dropUntilLevel: number | null = null;
  for (const el of els) {
    if (el.kind === "p" && el.level !== null) {
      if (dropUntilLevel !== null && el.level <= dropUntilLevel) dropUntilLevel = null;
      if (dropUntilLevel === null && BANNED_HEADING.test(el.text)) {
        dropUntilLevel = el.level;
        removed.push(`[section] ${el.text}`);
        continue;
      }
    }
    if (dropUntilLevel !== null && el.kind !== "other") {
      if (el.text.trim()) removed.push(`  ${el.text}`);
      continue;
    }
    if ((el.kind === "p" || el.xml.startsWith("<w:sdt")) && BANNED_LINE.test(el.text)) {
      removed.push(el.text);
      continue;
    }
    if (el.kind === "tbl") {
      const t = filterTable(el.xml, removed);
      if (t) kept.push(t);
      continue;
    }
    kept.push(el.xml);
  }
  zip.file("word/document.xml", docXml.slice(0, bodyStart) + kept.join("") + docXml.slice(bodyEnd));

  // Headers/footers: drop money/signature lines (e.g. "Invoice #", "Proposal total").
  for (const f of Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    let xml = zip.file(f)!.asText();
    for (const m of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
      const t = textOf(m);
      if (BANNED_LINE.test(t)) {
        removed.push(`[${f.includes("header") ? "header" : "footer"}] ${t}`);
        xml = xml.replace(m, "<w:p/>");
      }
    }
    zip.file(f, xml);
  }

  const buffer = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  const violations = docxText(buffer)
    .split("\n")
    .filter((l) => SUB_COPY_FORBIDDEN.test(l));
  return { buffer, removed, violations };
}
