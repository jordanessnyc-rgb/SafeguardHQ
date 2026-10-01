/**
 * Showing an email "like a real email" safely. The HTML is cleaned here (no scripts, forms, iframes
 * or event handlers) and then shown in a sandboxed iframe that can't run scripts either, so a
 * hostile email can't touch the CRM. Remote images stay off until someone clicks "Show images"
 * (they can be tracking pixels), as in Gmail and Outlook.
 */
import sanitizeHtml from "sanitize-html";

const TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "img", "font", "center", "span", "div", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "style", "u", "s", "small", "big", "sup", "sub", "hr", "br",
];
const CELL = ["align", "valign", "width", "height", "bgcolor", "colspan", "rowspan", "nowrap", "background"];

export function cleanEmailHtml(html: string, opts: { images: boolean }): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const out = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowVulnerableTags: true, // <style> is needed for email layouts; it can't run code
    allowedAttributes: {
      "*": ["style", "class", "align", "dir", "lang", "title", "width", "height", "bgcolor", "color", "valign", "border"],
      a: ["href", "name", "title", "target", "rel"],
      img: ["src", "alt", "width", "height", "border", "data-blocked"],
      font: ["face", "size", "color"],
      table: ["cellpadding", "cellspacing", "border", "width", "align", "bgcolor", "role"],
      td: CELL,
      th: CELL,
      col: ["width", "span"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tag, attribs) => ({ tagName: "a", attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
      img: (tag, attribs) => {
        const src = attribs.src ?? "";
        // cid: pictures (signature logos) weren't kept; drop them rather than show a broken icon.
        if (!/^(https?:|data:image\/)/i.test(src)) return { tagName: "span", attribs: {} };
        if (!opts.images && /^https?:/i.test(src)) {
          blockedImages++;
          return { tagName: "img", attribs: { ...attribs, src: "", "data-blocked": "1", alt: attribs.alt ?? "" } };
        }
        return { tagName: "img", attribs };
      },
    },
  });
  const finalHtml = opts.images ? out : out.replace(/url\(\s*['"]?https?:[^)]*\)/gi, "none");
  return { html: finalHtml, blockedImages };
}

/** A complete document for the iframe's srcdoc. */
export function emailDocument(html: string, opts: { images: boolean }): { doc: string; blockedImages: number } {
  const { html: body, blockedImages } = cleanEmailHtml(html, opts);
  const imgSrc = opts.images ? "https: data:" : "data:";
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src https: data:">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:#fff;color:#1f2328}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:4px 2px;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
img[data-blocked]{display:inline-block;background:#f1f3f4;min-width:16px;min-height:16px}
table{max-width:100%}
blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:2px solid #d0d7de;color:#57606a}
a{color:#146432}
pre{white-space:pre-wrap}
</style></head><body>${body}</body></html>`;
  return { doc, blockedImages };
}

/**
 * Plain-text email split into what was written and the quoted thread below it ("On … wrote:",
 * "-----Original Message-----", "From: … Sent: …", or a run of "> " lines), like mail apps fold it.
 */
export function splitQuoted(text: string): { main: string; quoted: string | null } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const markers = [
    /^\s*On .{4,200}wrote:\s*$/,
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*-{2,}\s*Forwarded message\s*-{2,}/i,
    /^\s*From:\s.+$/,
    /^\s*_{20,}\s*$/,
  ];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const isQuoteRun = /^\s*>/.test(l) && lines.slice(i, i + 3).every((x) => /^\s*(>|$)/.test(x));
    // "From:" only counts as a reply header when "Sent:"/"Date:" follows within a few lines.
    const isFrom = markers[3].test(l) && lines.slice(i + 1, i + 5).some((x) => /^\s*(Sent|Date):\s/.test(x));
    if (markers[0].test(l) || markers[1].test(l) || markers[2].test(l) || markers[4].test(l) || isFrom || isQuoteRun) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      if (main.trim()) return { main, quoted: lines.slice(i).join("\n").trim() };
    }
  }
  return { main: text.trimEnd(), quoted: null };
}
