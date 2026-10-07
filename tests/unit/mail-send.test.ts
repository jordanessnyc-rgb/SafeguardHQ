import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildMessage } from "@/lib/integrations/titan-mail";

describe("buildMessage", () => {
  it("writes Cc, threads a reply (In-Reply-To + References) and carries attachments", async () => {
    const { messageId, raw } = await buildMessage({
      from: "sales@ess-nyc.com",
      to: "tenant@example.com",
      cc: ["super@example.com", "pm@example.com"],
      subject: "Re: Mold inspection",
      text: "Thanks — confirmed for Monday.",
      inReplyTo: "<abc@example.com>",
      references: ["<first@example.com>"],
      attachments: [{ filename: "report.pdf", content: Buffer.from("%PDF-1.4"), contentType: "application/pdf" }],
    });
    expect(messageId).toMatch(/^<[0-9a-f-]+@ess-nyc\.com>$/);
    const m = await simpleParser(raw);
    expect(m.messageId).toBe(messageId);
    expect((m.cc as { value: { address?: string }[] }).value.map((a) => a.address)).toEqual(["super@example.com", "pm@example.com"]);
    expect(m.inReplyTo).toBe("<abc@example.com>");
    expect(m.references).toEqual(["<first@example.com>", "<abc@example.com>"]);
    expect(m.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([["report.pdf", "application/pdf", "%PDF-1.4"]]);
  });

  it("leaves threading headers and Cc out of a fresh message", async () => {
    const { raw } = await buildMessage({ from: "sales@ess-nyc.com", to: "a@example.com", subject: "Hi", text: "Hello", cc: [] });
    const m = await simpleParser(raw);
    expect(m.cc).toBeUndefined();
    expect(m.inReplyTo).toBeUndefined();
    expect(m.references).toBeUndefined();
    expect(m.attachments).toEqual([]);
  });
});
