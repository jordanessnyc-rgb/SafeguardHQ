/** DOCX rendering (SPEC §10) and the sub copy generator + its release validation. */
import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { Document, FootnoteReferenceRun, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, Header } from "docx";
import { docxText, loadTemplate, renderDocx } from "@/lib/docs/render";
import { makeSubCopy } from "@/lib/docs/sub-copy";

// 1×1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("template rendering", () => {
  it("fills the proposal template, loops line items, and shows missing values as [tags]", () => {
    const { buffer, placeholder } = loadTemplate("ESS_Proposal");
    expect(placeholder).toBe(true);
    const out = renderDocx(buffer, {
      brand_name: "Environmental Safeguard Solutions",
      proposal_number: "ESS-2026-0042-P1",
      proposal_date: "September 24, 2026",
      client_name: "Pat Lee",
      property_address: "420 Central Park West, Apt 2E",
      service_name: "Mold assessment",
      scope: "Visual inspection of all rooms.\nAir sampling (4).",
      lines: [
        { description: "Mold assessment", qty: 1, unit_price: "$1,450.00", amount: "$1,450.00" },
        { description: "Air samples", qty: 4, unit_price: "$100.00", amount: "$400.00" },
      ],
      total: "$1,850.00",
      valid_days: 30,
    });
    const text = docxText(out);
    expect(text).toContain("Proposal ESS-2026-0042-P1");
    expect(text).toContain("Air samples");
    expect(text).toContain("$1,850.00");
    expect(text).toContain("[client_org]"); // missing → visible
    expect(text).toContain("Client name: ____");
    expect(text).not.toMatch(/Prepared by|ESS signature/); // client-signature-only block
  });

  it("renders report sections and embeds a photo log", () => {
    const out = renderDocx(
      loadTemplate("ESS_Report").buffer,
      { brand_name: "ESS", report_title: "Mold Assessment Report", sections: [{ title: "Summary of findings", body: "Visible growth in bathroom." }], samples: [{ sample_id: "S1", type: "AIR", location: "Bath", result: "1,200 spores/m³" }] },
      [{ data: PNG, ext: "png", caption: "Bathroom ceiling", widthPx: 1, heightPx: 1 }],
    );
    const zip = new PizZip(out);
    expect(zip.file("word/media/ess_photo_1.png")).toBeTruthy();
    expect(zip.file("word/_rels/document.xml.rels")!.asText()).toContain("rIdEssPhoto1");
    expect(zip.file("[Content_Types].xml")!.asText()).toContain('Extension="png"');
    const text = docxText(out);
    expect(text).toContain("Summary of findings");
    expect(text).toContain("Photo 1: Bathroom ceiling");
    expect(text).toContain("1,200 spores/m³");
  });
});

async function sampleReport() {
  const cell = (t: string) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph("ESS · Invoice #1043")] }) },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Mold Assessment Report")] }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Scope of remediation")] }),
          new Paragraph("Remove and replace drywall in bathroom (approx. 40 sq ft)."),
          new Paragraph("Funding for this work is provided through the SCN program."),
          new Paragraph({ children: [new ImageRun({ type: "png", data: PNG, transformation: { width: 50, height: 50 } })] }),
          new Paragraph("Photo 1: Bathroom ceiling, north wall."),
          new Table({
            rows: [
              new TableRow({ children: [cell("Area"), cell("Work")] }),
              new TableRow({ children: [cell("Bathroom"), cell("HEPA vacuum, antimicrobial")] }),
              new TableRow({ children: [cell("Hall"), cell("Contractor cost $850.00")] }),
            ],
          }),
          new Table({ rows: [new TableRow({ children: [cell("Fee"), cell("Amount")] }), new TableRow({ children: [cell("Assessment"), cell("$650")] })] }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Pricing")] }),
          new Paragraph("Remediation estimate: 2,400 dollars"),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Payment schedule")] }),
          new Paragraph("50% deposit."),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Work practices")] }),
          new Paragraph("Containment with 6-mil poly; negative air."),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Tenant consent")] }),
          new Paragraph("Tenant: Ana Lopez consents to entry."),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Clearance criteria")] }),
          new Paragraph("Visual pass and air samples below outdoor baseline."),
          new Paragraph("Signature: ____________________"),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe("sub copy generator", () => {
  it("removes pricing, funding, consent and signatures; keeps scope, work practices and photos; validates clean", async () => {
    const { buffer, removed, violations } = makeSubCopy(await sampleReport());
    const text = docxText(buffer);
    expect(violations).toEqual([]);
    for (const kept of ["Scope of remediation", "Remove and replace drywall", "HEPA vacuum", "Work practices", "Containment with 6-mil poly", "Clearance criteria", "Photo 1: Bathroom ceiling"]) expect(text).toContain(kept);
    for (const gone of ["$", "Funding", "Contractor cost", "Pricing", "2,400", "deposit", "Ana Lopez", "Signature", "Invoice", "Fee"]) expect(text).not.toContain(gone);
    expect(new PizZip(buffer).file("word/document.xml")!.asText()).toContain("<w:drawing>"); // the photo survives
    expect(removed).toEqual(expect.arrayContaining(["[section] Pricing", "[section] Tenant consent", "[header] ESS · Invoice #1043", "[table] Fee Amount", "[row] Hall Contractor cost $850.00"]));
  });

  it("blocks release when forbidden words survive the filters (e.g. in a footnote)", async () => {
    const doc = new Document({
      footnotes: { 1: { children: [new Paragraph("Funding: SCN program, $1,200 cap.")] } },
      sections: [{ children: [new Paragraph({ children: [new TextRun("Scope: replace drywall."), new FootnoteReferenceRun(1)] })] }],
    });
    const r = makeSubCopy(Buffer.from(await Packer.toBuffer(doc)));
    expect(r.violations).toEqual(["Funding: SCN program, $1,200 cap."]);
  });
});
