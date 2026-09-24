/**
 * Generates the PLACEHOLDER DOCX templates in /templates/placeholder. They exist so proposals and
 * report drafts work before Jordan provides ESS's real templates (SPEC §14 item 4). Drop his files
 * in /templates as ESS_Proposal.docx / ESS_Report.docx (same {tags}) and they're used instead.
 *   pnpm tsx scripts/make-placeholder-templates.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

const GREEN = "146432";
const SAGE = "50823C";
const out = path.join(__dirname, "..", "templates", "placeholder");

const brandHeader = () =>
  new Header({
    children: [
      new Paragraph({ children: [new TextRun({ text: "{brand_name}", bold: true, color: GREEN, size: 28 })] }),
      new Paragraph({ children: [new TextRun({ text: "47-58 43rd Street, Queens, NY 11377 · 929-305-1232 · sales@ess-nyc.com · ess-nyc.com", color: SAGE, size: 16 })] }),
      new Paragraph({ border: { bottom: { color: GREEN, space: 1, style: BorderStyle.SINGLE, size: 6 } }, children: [] }),
    ],
  });
const banner = () =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "PLACEHOLDER TEMPLATE — replace with ESS's real template (see RUNBOOK)", color: "B00020", bold: true, size: 16 })],
  });
const p = (text: string, opts: { bold?: boolean } = {}) => new Paragraph({ children: [new TextRun({ text, bold: opts.bold })] });
const h = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text, color: GREEN })] });
const cell = (text: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
const footer = (text: string) => new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, size: 14, color: SAGE })] })] });

async function proposal() {
  const doc = new Document({
    sections: [
      {
        headers: { default: brandHeader() },
        footers: { default: footer("{brand_name} · Proposal {proposal_number}") },
        children: [
          banner(),
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: "Proposal {proposal_number}", color: GREEN })] }),
          p("Date: {proposal_date}"),
          p("Prepared for: {client_name}"),
          p("{client_org}"),
          p("Property: {property_address}"),
          h("Scope of work"),
          p("{service_name}", { bold: true }),
          p("{scope}"),
          h("Fees"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: [cell("Description", true), cell("Qty", true), cell("Unit price", true), cell("Amount", true)] }),
              new TableRow({ children: [cell("{#lines}{description}"), cell("{qty}"), cell("{unit_price}"), cell("{amount}{/lines}")] }),
              new TableRow({ children: [cell("Total", true), cell(""), cell(""), cell("{total}", true)] }),
            ],
          }),
          p(""),
          p("This proposal is valid for {valid_days} days from the date above."),
          h("Terms"),
          p("[ESS standard terms — Jordan to provide]"),
          h("Client acceptance"),
          p("By signing below, the client authorizes ESS to perform the scope of work above at the fees stated."),
          p(""),
          p("Client name: ______________________________"),
          // Invisible DocuSign anchors (white, tiny): the signature and date tabs land here.
          new Paragraph({
            children: [
              new TextRun("Signature: "),
              new TextRun({ text: "\\ess_sign\\", color: "FFFFFF", size: 2 }),
              new TextRun("________________________________   Date: "),
              new TextRun({ text: "\\ess_date\\", color: "FFFFFF", size: 2 }),
              new TextRun("______________"),
            ],
          }),
        ],
      },
    ],
  });
  writeFileSync(path.join(out, "ESS_Proposal.docx"), await Packer.toBuffer(doc));
}

async function report() {
  const doc = new Document({
    sections: [
      {
        headers: { default: brandHeader() },
        footers: { default: footer("{brand_name} · {job_number} · {report_status}") },
        children: [
          banner(),
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: "{report_title}", color: GREEN })] }),
          p("{draft_notice}", { bold: true }),
          p("Job: {job_number}"),
          p("Date: {report_date}"),
          p("Client: {client_name}"),
          p("Property: {property_address}"),
          p("Assessor: {assessor}"),
          p("{#sections}"),
          h("{title}"),
          p("{body}"),
          p("{/sections}"),
          h("Sample results"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: [cell("Sample", true), cell("Type", true), cell("Location", true), cell("Result", true)] }),
              new TableRow({ children: [cell("{#samples}{sample_id}"), cell("{type}"), cell("{location}"), cell("{result}{/samples}")] }),
            ],
          }),
          h("Limitations"),
          p("[ESS standard limitations language — Jordan to provide]"),
          h("Photo log"),
          p("{@photo_log}"),
          h("Signature"),
          p("{assessor}"),
          p("[License numbers — Jordan to provide]"),
        ],
      },
    ],
  });
  writeFileSync(path.join(out, "ESS_Report.docx"), await Packer.toBuffer(doc));
}

(async () => {
  await proposal();
  await report();
  console.log("Wrote placeholder templates to", out);
})();
