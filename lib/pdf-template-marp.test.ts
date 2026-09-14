// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderMarpHtml, parseTemplateData } from "./pdf-template-marp.js";

const MINIMAL_THEME = `/* @theme test-theme */
section { background: #fff; color: #111; padding: 12mm; font-family: sans-serif; }
`;

const MINIMAL_TEMPLATE = `---
marp: true
theme: test-theme
size: A4
paginate: false
html: true
---

# {{titolo}}

Ciao **{{nome}}**.

---

## Sezione due

Contenuto secondario.
`;

describe("renderMarpHtml", () => {
  it("compiles Mustache placeholders and renders Marp sections", () => {
    const { bodyHtml } = renderMarpHtml({
      templateMarp: MINIMAL_TEMPLATE,
      templateCss: MINIMAL_THEME,
      dataObj: { titolo: "Esempio", nome: "Mario Rossi" },
    });
    expect(bodyHtml).toContain("Esempio");
    expect(bodyHtml).toContain("Mario Rossi");
    expect(bodyHtml).toMatch(/<section[\s>]/);
    // The `---` separator should produce more than one section.
    const sectionCount = (bodyHtml.match(/<section/g) ?? []).length;
    expect(sectionCount).toBeGreaterThanOrEqual(2);
  });

  it("HTML-escapes data values by default via Mustache double-stache", () => {
    const { bodyHtml } = renderMarpHtml({
      templateMarp: MINIMAL_TEMPLATE,
      templateCss: MINIMAL_THEME,
      dataObj: { titolo: "<script>alert(1)</script>", nome: "& \"Mario\"" },
    });
    expect(bodyHtml).not.toContain("<script>alert(1)</script>");
    expect(bodyHtml).toContain("&lt;script&gt;");
    expect(bodyHtml).toContain("&amp;");
    expect(bodyHtml).toContain("&quot;");
  });

  it("embeds the theme CSS string into the output", () => {
    const themeWithMarker = `/* @theme test-theme */
section { background: rgb(123,45,67); padding: 12mm; }
`;
    const { bodyHtml } = renderMarpHtml({
      templateMarp: MINIMAL_TEMPLATE,
      templateCss: themeWithMarker,
      dataObj: { titolo: "x", nome: "y" },
    });
    expect(bodyHtml).toContain("rgb(123,45,67)");
  });

  it("adds a print page-break CSS rule for puppeteer page splitting", () => {
    const { bodyHtml } = renderMarpHtml({
      templateMarp: MINIMAL_TEMPLATE,
      templateCss: MINIMAL_THEME,
      dataObj: { titolo: "x", nome: "y" },
    });
    expect(bodyHtml).toMatch(/page-break-after:\s*always/);
  });

  it("throws on empty templateMarp", () => {
    expect(() =>
      renderMarpHtml({
        templateMarp: "",
        templateCss: MINIMAL_THEME,
        dataObj: {},
      }),
    ).toThrow(/templateMarp/);
  });

  it("throws on empty templateCss", () => {
    expect(() =>
      renderMarpHtml({
        templateMarp: MINIMAL_TEMPLATE,
        templateCss: "",
        dataObj: {},
      }),
    ).toThrow(/templateCss/);
  });

  it("allows inline HTML in the template (html: true)", () => {
    const tpl = `---
marp: true
theme: test-theme
size: A4
html: true
---

<div class="custom-block">
  <span class="brand">{{brand}}</span>
</div>
`;
    const { bodyHtml } = renderMarpHtml({
      templateMarp: tpl,
      templateCss: MINIMAL_THEME,
      dataObj: { brand: "Acme" },
    });
    expect(bodyHtml).toContain('class="custom-block"');
    expect(bodyHtml).toContain('class="brand"');
    expect(bodyHtml).toContain("Acme");
  });
});

describe("parseTemplateData", () => {
  it("returns ok for a well-formed JSON object", () => {
    const r = parseTemplateData('{"foo": "bar", "n": 1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ foo: "bar", n: 1 });
  });

  it("returns error for malformed JSON", () => {
    const r = parseTemplateData("{not json}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON malformato/);
  });

  it("returns error for JSON that is not an object", () => {
    const r1 = parseTemplateData('"a string"');
    expect(r1.ok).toBe(false);
    const r2 = parseTemplateData("[1,2,3]");
    expect(r2.ok).toBe(false);
    const r3 = parseTemplateData("null");
    expect(r3.ok).toBe(false);
  });

  it("accepts an empty object", () => {
    const r = parseTemplateData("{}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });
});
