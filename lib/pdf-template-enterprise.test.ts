// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderEnterpriseHtml, buildEnterpriseCss } from "./pdf-template-enterprise.js";

describe("pdf-template-enterprise", () => {
  describe("buildEnterpriseCss", () => {
    it("injects the accent hex as a CSS custom property", () => {
      const css = buildEnterpriseCss("#F16034");
      expect(css).toContain("--brand-accent: #F16034");
    });

    it("declares cover layout and body sections", () => {
      const css = buildEnterpriseCss("#000000");
      expect(css).toMatch(/\.cover\b/);
      expect(css).toMatch(/\.cover-title\b/);
      expect(css).toMatch(/\.cover-divider\b/);
      expect(css).toMatch(/\.body h1\b/);
      expect(css).toMatch(/\.cover\b[^}]*page-break-after:\s*always/s);
    });
  });

  describe("renderEnterpriseHtml", () => {
    const base = {
      markdown: "# Sezione uno\n\nContenuto.\n\n# Sezione due\n\nAltro contenuto.",
      brandAccentHex: "#F16034",
      brandLogoSrc: "data:image/png;base64,iVBORw0KGgo=",
      documentTitle: "Blueprint della proposta",
      documentSubtitle: "Preparato per Mario Rossi · Maggio 2026",
      brandFooterText: "Acme Inc. · acme.com",
      documentDate: "Milano, 15 maggio 2026",
    };

    it("includes cover with logo, title, subtitle and date", () => {
      const { bodyHtml } = renderEnterpriseHtml(base);
      expect(bodyHtml).toContain('class="cover"');
      expect(bodyHtml).toContain('class="cover-logo"');
      expect(bodyHtml).toContain("Blueprint della proposta");
      expect(bodyHtml).toContain("Preparato per Mario Rossi");
      expect(bodyHtml).toContain("Milano, 15 maggio 2026");
    });

    it("renders markdown body after the cover", () => {
      const { bodyHtml } = renderEnterpriseHtml(base);
      const coverEnd = bodyHtml.indexOf('<div class="body">');
      const sectionUno = bodyHtml.indexOf("Sezione uno");
      expect(coverEnd).toBeGreaterThan(0);
      expect(sectionUno).toBeGreaterThan(coverEnd);
    });

    it("omits the cover logo block when brandLogoSrc is null", () => {
      const { bodyHtml } = renderEnterpriseHtml({ ...base, brandLogoSrc: null });
      expect(bodyHtml).not.toContain('class="cover-logo"');
      expect(bodyHtml).toContain("Blueprint della proposta");
    });

    it("omits the subtitle when documentSubtitle is null", () => {
      const { bodyHtml } = renderEnterpriseHtml({ ...base, documentSubtitle: null });
      expect(bodyHtml).not.toContain('class="cover-subtitle"');
    });

    it("falls back to an italian date when documentDate is null", () => {
      const { bodyHtml } = renderEnterpriseHtml({ ...base, documentDate: null });
      const match = bodyHtml.match(/class="cover-date">([^<]+)</);
      expect(match).not.toBeNull();
      const italianMonths = /(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i;
      expect(match![1]).toMatch(italianMonths);
    });

    it("escapes HTML in user-provided fields", () => {
      const { bodyHtml } = renderEnterpriseHtml({
        ...base,
        documentTitle: "Title with <script>alert(1)</script>",
        documentSubtitle: 'Subtitle with "quotes" & ampersand',
      });
      expect(bodyHtml).not.toContain("<script>");
      expect(bodyHtml).toContain("&lt;script&gt;");
      expect(bodyHtml).toContain("&amp;");
      expect(bodyHtml).toContain("&quot;");
    });

    it("returns a header template containing the logo and document title", () => {
      const { headerTemplate } = renderEnterpriseHtml(base);
      expect(headerTemplate).toContain("Blueprint della proposta");
      expect(headerTemplate).toContain("data:image/png;base64");
      expect(headerTemplate).toContain("max-height: 6mm");
    });

    it("returns a footer template containing brand text and page placeholders", () => {
      const { footerTemplate } = renderEnterpriseHtml(base);
      expect(footerTemplate).toContain("Acme Inc. · acme.com");
      expect(footerTemplate).toContain('class="pageNumber"');
      expect(footerTemplate).toContain('class="totalPages"');
    });

    it("returns an empty footer-left when brandFooterText is null but still shows pagination", () => {
      const { footerTemplate } = renderEnterpriseHtml({ ...base, brandFooterText: null });
      expect(footerTemplate).toContain('class="pageNumber"');
      expect(footerTemplate).toContain('class="totalPages"');
      expect(footerTemplate).not.toContain("Acme");
    });

    it("uses a plain span placeholder when brandLogoSrc is null in the header", () => {
      const { headerTemplate } = renderEnterpriseHtml({ ...base, brandLogoSrc: null });
      expect(headerTemplate).not.toContain("<img");
      expect(headerTemplate).toContain("Blueprint della proposta");
    });
  });
});
