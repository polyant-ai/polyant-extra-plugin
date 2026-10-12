// SPDX-License-Identifier: AGPL-3.0-or-later

import MarkdownIt from "markdown-it";
import { escapeHtml } from "./escape-html.js";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

export interface EnterpriseTemplateOptions {
  markdown: string;
  brandAccentHex: string;
  brandLogoSrc: string | null;
  documentTitle: string;
  documentSubtitle: string | null;
  brandFooterText: string | null;
  documentDate: string | null;
}

export interface EnterpriseHtmlResult {
  bodyHtml: string;
  headerTemplate: string;
  footerTemplate: string;
}

export function buildEnterpriseCss(accentHex: string): string {
  return `
    :root { --brand-accent: ${accentHex}; }
    * { box-sizing: border-box; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #111;
      line-height: 1.6;
      font-size: 11pt;
      margin: 0;
      padding: 0;
    }
    .cover {
      page-break-after: always;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 36mm 24mm;
      text-align: center;
    }
    .cover-logo {
      max-width: 80mm;
      max-height: 30mm;
      margin-bottom: 22mm;
    }
    .cover-title {
      font-size: 28pt;
      font-weight: 600;
      letter-spacing: -0.015em;
      margin: 0;
      color: #111;
      line-height: 1.15;
    }
    .cover-divider {
      width: 60mm;
      height: 2px;
      background: var(--brand-accent);
      margin: 16pt auto 16pt;
      border: none;
    }
    .cover-subtitle {
      font-size: 13pt;
      color: #666;
      font-weight: 400;
      margin: 0;
      line-height: 1.4;
    }
    .cover-date {
      margin-top: auto;
      padding-top: 18mm;
      font-size: 10.5pt;
      color: #888;
    }
    .body {
      padding: 0 2mm;
    }
    .body h1 {
      font-size: 19pt;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 22pt 0 14pt;
      padding-left: 10pt;
      border-left: 3px solid var(--brand-accent);
      line-height: 1.25;
      page-break-after: avoid;
    }
    .body > h1:first-child {
      margin-top: 0;
    }
    .body h2 {
      font-size: 13.5pt;
      font-weight: 600;
      margin: 16pt 0 8pt;
      line-height: 1.3;
    }
    .body h3 {
      font-size: 11.5pt;
      font-weight: 600;
      margin: 12pt 0 6pt;
      color: #333;
    }
    .body p { margin: 0 0 9pt; }
    .body ul, .body ol { margin: 0 0 9pt 18pt; padding: 0; }
    .body li { margin: 2pt 0; }
    .body strong { font-weight: 600; }
    .body em { font-style: italic; }
    .body table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0 16pt;
      font-size: 10pt;
    }
    .body thead th {
      background: rgba(0, 0, 0, 0.03);
      color: #111;
      font-weight: 600;
      text-align: left;
      padding: 8pt 10pt;
      border-bottom: 2px solid var(--brand-accent);
    }
    .body tbody td {
      padding: 6pt 10pt;
      border-bottom: 1px solid #eee;
      vertical-align: top;
    }
    .body tbody tr:nth-child(even) td {
      background: rgba(0, 0, 0, 0.015);
    }
    .body blockquote {
      border-left: 3px solid #ddd;
      margin: 0 0 12pt;
      padding: 2pt 14pt;
      color: #555;
      font-style: normal;
    }
    .body code {
      font-family: "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 9.5pt;
      background: #f4f4f4;
      padding: 1px 4px;
      border-radius: 3px;
    }
    .body pre {
      background: #f4f4f4;
      padding: 10pt 12pt;
      border-radius: 4px;
      overflow-x: hidden;
      font-size: 9pt;
    }
    .body pre code { background: none; padding: 0; }
    .body hr {
      border: none;
      border-top: 1px solid #ddd;
      margin: 18pt 0;
    }
    .body a { color: var(--brand-accent); text-decoration: none; }
    .body img { max-width: 100%; }
    @media print {
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;
}


function formatEnglishDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function renderEnterpriseHtml(opts: EnterpriseTemplateOptions): EnterpriseHtmlResult {
  const {
    markdown,
    brandAccentHex,
    brandLogoSrc,
    documentTitle,
    documentSubtitle,
    brandFooterText,
    documentDate,
  } = opts;

  const bodyMarkdown = md.render(markdown);
  const css = buildEnterpriseCss(brandAccentHex);

  const coverLogo = brandLogoSrc
    ? `<img class="cover-logo" src="${escapeHtml(brandLogoSrc)}" alt="" />`
    : "";
  const coverSubtitle = documentSubtitle
    ? `<p class="cover-subtitle">${escapeHtml(documentSubtitle)}</p>`
    : "";
  const dateLabel = documentDate ?? formatEnglishDate(new Date());

  const bodyHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(documentTitle)}</title><style>${css}</style></head><body><div class="cover">${coverLogo}<h1 class="cover-title">${escapeHtml(documentTitle)}</h1><div class="cover-divider"></div>${coverSubtitle}<div class="cover-date">${escapeHtml(dateLabel)}</div></div><div class="body">${bodyMarkdown}</div></body></html>`;

  const headerStyle = "font-family: 'Inter', system-ui, sans-serif; font-size: 8pt; color: #888; padding: 0 18mm; width: 100%; display: flex; justify-content: space-between; align-items: center;";
  const headerLogo = brandLogoSrc
    ? `<img src="${escapeHtml(brandLogoSrc)}" style="max-height: 6mm; max-width: 30mm;" alt="" />`
    : `<span></span>`;
  const headerTemplate = `<div style="${headerStyle}">${headerLogo}<span>${escapeHtml(documentTitle)}</span></div>`;

  const footerStyle = "font-family: 'Inter', system-ui, sans-serif; font-size: 8pt; color: #888; padding: 0 18mm; width: 100%; display: flex; justify-content: space-between; align-items: center;";
  const footerLeft = brandFooterText ? escapeHtml(brandFooterText) : "";
  const footerTemplate = `<div style="${footerStyle}"><span>${footerLeft}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

  return { bodyHtml, headerTemplate, footerTemplate };
}
