/**
 * DOCX template rendering (SPEC §10) with docxtemplater. Templates live in /templates (Jordan's
 * files); until he provides one, a clearly marked placeholder from /templates/placeholder is used.
 * Missing values render as a visible [tag] so a gap can't slip through unnoticed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export type TemplateName = "ESS_Proposal" | "ESS_Report";

export function loadTemplate(name: TemplateName, root = process.cwd()): { buffer: Buffer; placeholder: boolean } {
  const real = path.join(root, "templates", `${name}.docx`);
  if (existsSync(real)) return { buffer: readFileSync(real), placeholder: false };
  return { buffer: readFileSync(path.join(root, "templates", "placeholder", `${name}.docx`)), placeholder: true };
}

export type Photo = { data: Buffer; ext: "png" | "jpeg"; caption: string; widthPx?: number; heightPx?: number };

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const para = (text: string, opts: { bold?: boolean; italic?: boolean } = {}) =>
  `<w:p><w:r>${opts.bold || opts.italic ? `<w:rPr>${opts.bold ? "<w:b/>" : ""}${opts.italic ? "<w:i/>" : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

/**
 * Adds photos to the package (media + relationships + content types) and returns the raw XML for
 * a photo log, to be inserted with a {@photo_log} tag (free docxtemplater has no image module).
 */
export function embedPhotoLog(zip: PizZip, photos: Photo[]): string {
  if (!photos.length) return para("No photos.", { italic: true });
  const relsPath = "word/_rels/document.xml.rels";
  let rels = zip.file(relsPath)!.asText();
  let types = zip.file("[Content_Types].xml")!.asText();
  for (const ext of new Set(photos.map((p) => p.ext))) {
    if (!types.includes(`Extension="${ext}"`)) types = types.replace("</Types>", `<Default Extension="${ext}" ContentType="image/${ext}"/></Types>`);
  }
  const maxWidthEmu = 5_486_400; // 6 inches
  const xml = photos.map((p, i) => {
    const n = i + 1;
    const rid = `rIdEssPhoto${n}`;
    const file = `media/ess_photo_${n}.${p.ext}`;
    zip.file(`word/${file}`, p.data);
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${file}"/></Relationships>`);
    const ratio = p.widthPx && p.heightPx ? p.heightPx / p.widthPx : 0.75;
    const cx = maxWidthEmu;
    const cy = Math.round(cx * ratio);
    const drawing = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9000 + n}" name="Photo ${n}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${9000 + n}" name="Photo ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    return drawing + para(`Photo ${n}: ${p.caption}`, { italic: true });
  });
  zip.file(relsPath, rels);
  zip.file("[Content_Types].xml", types);
  return xml.join("");
}

export function renderDocx(template: Buffer, data: Record<string, unknown>, photos?: Photo[]): Buffer {
  const zip = new PizZip(template);
  const payload = photos ? { ...data, photo_log: embedPhotoLog(zip, photos) } : data;
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part) => (part.module === "rawxml" ? "" : `[${part.value}]`),
  });
  doc.render(payload);
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

/** Visible text of a DOCX (body, headers, footers), one paragraph per line. */
export function docxText(buf: Buffer): string {
  const zip = new PizZip(buf);
  const parts = Object.keys(zip.files).filter((f) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f));
  return parts
    .map((f) =>
      zip
        .file(f)!
        .asText()
        .split(/<\/w:p>/)
        .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
        .map((t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
        .filter((t) => t.trim())
        .join("\n"),
    )
    .join("\n");
}
