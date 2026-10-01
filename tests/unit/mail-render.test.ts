import { describe, expect, it } from "vitest";
import { cleanEmailHtml, emailDocument, splitQuoted } from "@/lib/mail/render";

const hostile = `<html><head><style>p > b{color:red} .x{background:url(https://t.example/a.png)}</style><script>alert(1)</script></head>
<body onload="steal()"><p style="background-image:url('https://t.example/p.gif')" onclick="x()">Hi <b>there</b>
<a href="javascript:alert(1)">bad</a> <a href="https://ok.example/">ok</a></p>
<img src="https://t.example/pixel.gif" width="1"><img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo=">
<form action="https://evil.example"><input name="password"></form><iframe src="https://evil.example"></iframe><object data="x"></object></body></html>`;

describe("cleanEmailHtml", () => {
  it("removes anything that could run code, post data or embed pages", () => {
    const { html } = cleanEmailHtml(hostile, { images: true });
    for (const bad of ["<script", "alert(1)", "onload", "onclick", "javascript:", "<form", "<input", "<iframe", "<object"]) expect(html).not.toContain(bad);
    expect(html).toContain("<b>there</b>");
    expect(html).toContain("p > b{color:red}"); // email CSS survives
    expect(html).toContain('<a href="https://ok.example/" target="_blank" rel="noopener noreferrer">');
  });

  it("blocks remote pictures (including CSS backgrounds) until asked, keeps inline data images", () => {
    const off = cleanEmailHtml(hostile, { images: false });
    expect(off.blockedImages).toBe(1);
    expect(off.html).not.toContain("t.example");
    expect(off.html).toContain('data-blocked="1"');
    expect(off.html).toContain("data:image/png");
    const on = cleanEmailHtml(hostile, { images: true });
    expect(on.blockedImages).toBe(0);
    expect(on.html).toContain("https://t.example/pixel.gif");
  });

  it("drops cid: pictures that weren't kept", () => {
    expect(cleanEmailHtml(hostile, { images: true }).html).not.toContain("cid:");
  });

  it("the iframe document locks down what the email can load", () => {
    expect(emailDocument("<p>x</p>", { images: false }).doc).toContain("default-src 'none'; img-src data:;");
    expect(emailDocument("<p>x</p>", { images: true }).doc).toContain("img-src https: data:;");
  });
});

describe("splitQuoted", () => {
  it("folds a Gmail-style reply", () => {
    expect(splitQuoted("Tuesday works.\n\nOn Mon, Sep 28, 2026 at 3:01 PM Jordan Adhami <jordan@ess-nyc.com> wrote:\n> Can we come Tuesday?")).toEqual({
      main: "Tuesday works.",
      quoted: "On Mon, Sep 28, 2026 at 3:01 PM Jordan Adhami <jordan@ess-nyc.com> wrote:\n> Can we come Tuesday?",
    });
  });
  it("folds an Outlook-style reply but not a 'From:' line in the message itself", () => {
    expect(splitQuoted("Yes.\n\nFrom: Jordan Adhami\nSent: Monday\nTo: Maria\nSubject: Visit").main).toBe("Yes.");
    expect(splitQuoted("Hi,\nFrom: the super, the key is at the desk.\nThanks").quoted).toBeNull();
  });
  it("leaves a message with no thread alone", () => {
    expect(splitQuoted("Just one line")).toEqual({ main: "Just one line", quoted: null });
  });
});
