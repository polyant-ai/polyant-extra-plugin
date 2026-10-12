// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import MarkdownIt from "markdown-it";
import puppeteer, { type Browser } from "puppeteer";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { renderEnterpriseHtml } from "../lib/pdf-template-enterprise.js";
import { renderMarpHtml, parseTemplateData } from "../lib/pdf-template-marp.js";

const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TEMPLATE_LENGTH = 200_000;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Counting semaphore — caps how many puppeteer renders run in parallel inside
 * the singleton Chromium browser. Each render uses one page (~50-100MB RSS),
 * so unbounded parallelism would OOM the engine under a burst of webhooks.
 *
 * Zero-deps implementation: `acquire()` returns immediately if a permit is
 * free, otherwise the caller is parked in `waiters` and woken by `release()`.
 * Permits never leak as long as callers wrap their critical section in
 * try/finally (the file does this around `generatePdfBuffer`).
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  private readonly capacity: number;

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer (got ${permits})`);
    }
    this.permits = permits;
    this.capacity = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.permits < this.capacity) {
      this.permits++;
    }
  }

  /** Snapshot of current state — for observability/tests. */
  stats(): { available: number; capacity: number; waiting: number } {
    return { available: this.permits, capacity: this.capacity, waiting: this.waiters.length };
  }
}

/**
 * Each render holds one Chromium page (~50-100MB RSS), so the cap is a memory
 * bound, not a throughput knob. Read from the environment here rather than from
 * the engine's config: a plugin's settings are its own, and the engine cannot
 * validate a variable it does not know about.
 */
function pdfConcurrency(): number {
  const raw = Number(process.env.PDF_CONCURRENCY);
  if (!Number.isInteger(raw) || raw < 1 || raw > 32) return 3;
  return raw;
}

const pdfSemaphore = new Semaphore(pdfConcurrency());

/** Test hook — do not use in application code. */
export const _internals = { pdfSemaphore };

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // No `executablePath` here on purpose. Puppeteer resolves it from its own
    // PUPPETEER_EXECUTABLE_PATH (getConfiguration.ts), which Dockerfile.engine
    // sets to the Alpine chromium package because the bundled binary is glibc.
    // Reading that variable ourselves only duplicated puppeteer's own default.
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

const PDF_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
    padding: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 0.4em; line-height: 1.2; }
  h2 { font-size: 16pt; margin: 1em 0 0.4em; line-height: 1.25; }
  h3 { font-size: 13pt; margin: 0.9em 0 0.3em; }
  h4, h5, h6 { font-size: 11pt; margin: 0.8em 0 0.2em; }
  p { margin: 0 0 0.8em; }
  ul, ol { margin: 0 0 0.8em 1.2em; padding: 0; }
  li { margin: 0.15em 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.6em 0 1em; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 10pt; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f4f4f4; padding: 10px 12px; border-radius: 4px; overflow-x: auto; font-size: 9.5pt; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0 0 0.8em; padding: 0.2em 0.9em; color: #555; }
  a { color: #0a58ca; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.2em 0; }
  img { max-width: 100%; }
  .ab-header-logo { text-align: right; margin: 0 0 1.2em; }
  .ab-header-logo img { display: inline-block; max-height: 60px; max-width: 220px; width: auto; height: auto; object-fit: contain; }
`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Process-wide cache of fetched header images, keyed by URL → data: URI.
// Inlining the image as base64 means Chromium never has to do a network
// fetch from inside the container — important on hosts where outbound HTTPS
// from the headless browser is unreliable (corporate firewalls, DNS issues,
// missing CA roots inside the Chromium sandbox). 80 PDFs in a burst → 1 HTTP
// fetch total.
const headerImageCache = new Map<string, string>();
const HEADER_IMAGE_FETCH_TIMEOUT_MS = 10_000;

async function resolveHeaderImage(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  const cached = headerImageCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEADER_IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[markdownToPdf] header image fetch failed: HTTP ${res.status} for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0].trim();
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    headerImageCache.set(url, dataUri);
    return dataUri;
  } catch (err) {
    console.warn(`[markdownToPdf] header image fetch failed: ${errMsg(err)} for ${url}`);
    return null;
  }
}

// Process-wide cache for textual templates (markdown, CSS) fetched by URL.
// Solves the LLM-output-size problem: passing 35KB of template+CSS through
// a tool call forces the model to emit those characters verbatim, which gpt-5.4
// truncates/synthesises. Hosting the assets on a CDN (e.g. HubSpot Files) and
// letting the tool fetch them keeps the LLM context tiny and the rendering exact.
const textTemplateCache = new Map<string, string>();
const TEXT_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_TEMPLATE_BYTES = 1_000_000; // 1MB cap on remote templates

async function resolveTextTemplate(url: string): Promise<string | null> {
  const cached = textTemplateCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TEXT_TEMPLATE_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[markdownToPdf] text template fetch failed: HTTP ${res.status} for ${url}`);
      return null;
    }
    const text = await res.text();
    if (text.length > MAX_TEXT_TEMPLATE_BYTES) {
      console.warn(`[markdownToPdf] text template too large: ${text.length} bytes (max ${MAX_TEXT_TEMPLATE_BYTES}) for ${url}`);
      return null;
    }
    textTemplateCache.set(url, text);
    return text;
  } catch (err) {
    console.warn(`[markdownToPdf] text template fetch failed: ${errMsg(err)} for ${url}`);
    return null;
  }
}

function renderHtml(markdown: string, headerImageSrc?: string): string {
  const body = md.render(markdown);
  const logoBlock = headerImageSrc
    ? `<div class="ab-header-logo"><img src="${escapeAttr(headerImageSrc)}" alt="logo" /></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body>${logoBlock}${body}</body></html>`;
}

interface EnterpriseRenderInput {
  markdown: string;
  brandAccentHex: string;
  brandLogoUrl: string | null;
  documentTitle: string;
  documentSubtitle: string | null;
  brandFooterText: string | null;
  documentDate: string | null;
}

async function generatePdfBuffer(markdown: string, headerImageUrl?: string): Promise<Buffer> {
  const headerImageSrc = headerImageUrl ? await resolveHeaderImage(headerImageUrl) : null;
  if (headerImageUrl && !headerImageSrc) {
    console.warn(`[markdownToPdf] proceeding without header image — fetch failed: ${headerImageUrl}`);
  }

  await pdfSemaphore.acquire();
  const stats = pdfSemaphore.stats();
  if (stats.waiting > 0) {
    console.log(`[markdownToPdf] render starting — capacity=${stats.capacity} available=${stats.available} queued=${stats.waiting}`);
  }
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    const html = renderHtml(markdown, headerImageSrc ?? undefined);
    await page.setContent(html, { waitUntil: "load", timeout: 20_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "18mm", bottom: "20mm", left: "18mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => undefined);
    pdfSemaphore.release();
  }
}

interface MarpRenderInput {
  templateMarp: string;
  templateCss: string;
  dataObj: Record<string, unknown>;
}

async function generateMarpPdfBuffer(input: MarpRenderInput): Promise<Buffer> {
  const { bodyHtml } = renderMarpHtml({
    templateMarp: input.templateMarp,
    templateCss: input.templateCss,
    dataObj: input.dataObj,
  });

  await pdfSemaphore.acquire();
  const stats = pdfSemaphore.stats();
  if (stats.waiting > 0) {
    console.log(`[markdownToPdf] marp render starting — capacity=${stats.capacity} available=${stats.available} queued=${stats.waiting}`);
  }
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(bodyHtml, { waitUntil: "load", timeout: 20_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => undefined);
    pdfSemaphore.release();
  }
}

async function generateEnterprisePdfBuffer(input: EnterpriseRenderInput): Promise<Buffer> {
  const brandLogoSrc = input.brandLogoUrl ? await resolveHeaderImage(input.brandLogoUrl) : null;
  if (input.brandLogoUrl && !brandLogoSrc) {
    console.warn(`[markdownToPdf] enterprise template proceeding without logo — fetch failed: ${input.brandLogoUrl}`);
  }

  const { bodyHtml, headerTemplate, footerTemplate } = renderEnterpriseHtml({
    markdown: input.markdown,
    brandAccentHex: input.brandAccentHex,
    brandLogoSrc,
    documentTitle: input.documentTitle,
    documentSubtitle: input.documentSubtitle,
    brandFooterText: input.brandFooterText,
    documentDate: input.documentDate,
  });

  await pdfSemaphore.acquire();
  const stats = pdfSemaphore.stats();
  if (stats.waiting > 0) {
    console.log(`[markdownToPdf] enterprise render starting — capacity=${stats.capacity} available=${stats.available} queued=${stats.waiting}`);
  }
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(bodyHtml, { waitUntil: "load", timeout: 20_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: "22mm", right: "16mm", bottom: "20mm", left: "16mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => undefined);
    pdfSemaphore.release();
  }
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim().replace(/\.pdf$/i, "");
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "document").slice(0, 120) + ".pdf";
}

export default defineTool({
  name: "markdownToPdf",
  description:
    "Generate an A4 PDF from Markdown content.\n" +
    "Accepts GFM-style tables, lists, code blocks, links, images, blockquotes.\n" +
    "Optionally accepts headerImageUrl: a public https:// URL (e.g. a company logo) rendered as the FIRST element of the document, right-aligned, before the Markdown content. Visible on the first page.\n" +
    "For enterprise output (cover page, brand colors, header/footer with pagination) pass template=\"enterprise\" + brandAccentHex + brandLogoUrl + documentTitle.\n" +
    "Returns an opaque fileHandle (valid for 10 minutes) consumable by a follow-up tool (e.g. extra:fileUpload, hubspot:file) to avoid passing the binary between tool calls.\n" +
    "Input limit: 100KB of markdown. Output limit: 10MB.",
  category: "document",
  inputExamples: [
    {
      label: "Quote summary",
      input: {
        markdown: "# Quote no. 2026-001\n\n**Customer:** Jane Doe\n\n| Item | Amount |\n|---|---|\n| Service A | $100 |\n| Service B | $250 |\n\n**Total: $350**",
        filename: "quote-2026-001",
        headerImageUrl: null,
      },
    },
    {
      label: "Proposal with company logo in the header",
      input: {
        markdown: "# Proposal\n\nDear Customer,\n\nplease find the proposal attached.",
        filename: "customer-proposal",
        headerImageUrl: "https://cdn.example.com/logo.png",
      },
    },
    {
      label: "Enterprise document with cover, brand and pagination",
      input: {
        markdown: "# Section 1\n\nContent of the first section.\n\n# Section 2\n\nContent of the second section.",
        filename: "enterprise-document",
        template: "enterprise",
        brandAccentHex: "#F16034",
        brandLogoUrl: "https://cdn.example.com/logo.png",
        documentTitle: "Document title",
        documentSubtitle: "Prepared for Jane Doe · May 2026",
        brandFooterText: "Acme Inc. · acme.com",
        documentDate: "London, 15 May 2026",
      },
    },
    {
      label: "Custom Marp+Mustache template supplied by the caller (inline)",
      input: {
        markdown: "n/a",
        filename: "marp-document",
        template: "marp-custom",
        templateMarp: "---\nmarp: true\ntheme: custom-a\nsize: A4\nhtml: true\n---\n# {{title}}\n\nHello **{{name}}**.",
        templateCss: "/* @theme custom-a */\nsection { background: #FFF; color: #111; padding: 20mm; font-family: sans-serif; }",
        templateData: "{\"title\":\"Example\",\"name\":\"Jane Doe\"}",
      },
    },
    {
      label: "Custom Marp template from a URL (preferred for templates >5KB)",
      input: {
        markdown: "n/a",
        filename: "marp-document-url",
        template: "marp-custom",
        templateMarpUrl: "https://cdn.example.com/template.md",
        templateCssUrl: "https://cdn.example.com/theme.css",
        templateData: "{\"title\":\"Example\",\"name\":\"Jane Doe\"}",
      },
    },
  ],
  parameters: z.object({
    markdown: z
      .string()
      .min(1)
      .describe("Markdown content to convert to PDF. Supports GFM (tables, code blocks)."),
    filename: z
      .string()
      .min(1)
      .describe("Desired file name without extension (e.g. 'customer-proposal'). The .pdf extension is added automatically. Unsafe characters are replaced with '-'."),
    headerImageUrl: z
      .string()
      .nullable()
      .describe("Optional: public HTTPS URL of an image (e.g. a company logo) shown as the first element of the document, right-aligned, before the Markdown content. Visible on the first page. Must start with https://. If null, no logo. Ignored when template='enterprise' (uses brandLogoUrl)."),
    template: z
      .enum(["default", "enterprise", "marp-custom"])
      .nullable()
      .describe("Visual style. 'default' or null = the basic style. 'enterprise' = cover page + brand colors + header/footer with pagination (requires brandAccentHex, brandLogoUrl, documentTitle). 'marp-custom' = arbitrary Marp+Mustache template supplied by the caller (requires templateMarp, templateCss, templateData)."),
    brandAccentHex: z
      .string()
      .nullable()
      .describe("Only template='enterprise': accent color as a 6-digit hex (e.g. '#0066CC' or '#F16034'). Injected as the CSS custom property --brand-accent (cover divider, H1 left border, table header). Validated at runtime."),
    brandLogoUrl: z
      .string()
      .nullable()
      .describe("Only template='enterprise': HTTPS URL of the company logo. Large on the cover, small in the header of pages 2+. Must start with https://."),
    documentTitle: z
      .string()
      .nullable()
      .describe("Only template='enterprise': main title shown on the cover (e.g. 'Proposal blueprint'). Also shown in the header of pages 2+. If null, falls back to the first H1 of the markdown."),
    documentSubtitle: z
      .string()
      .nullable()
      .describe("Only template='enterprise': cover subtitle (e.g. 'Prepared for Jane Doe · May 2026'). If null, no subtitle."),
    brandFooterText: z
      .string()
      .nullable()
      .describe("Only template='enterprise': footer text for pages 2+ (e.g. 'Exelab · polyant.ai' or 'Acme Inc. · acme.com'). If null, the footer shows only the page numbering."),
    documentDate: z
      .string()
      .nullable()
      .describe("Only template='enterprise': date shown at the bottom of the cover (e.g. 'London, 15 May 2026'). If null, today's date is generated in Italian (it-IT) without a city prefix."),
    templateMarp: z
      .string()
      .nullable()
      .describe("Only template='marp-custom': Marp+Mustache template passed inline. Alternative to templateMarpUrl. Maximum 200KB. Discouraged for large templates because the LLM may truncate them: prefer templateMarpUrl."),
    templateCss: z
      .string()
      .nullable()
      .describe("Only template='marp-custom': theme CSS passed inline. Alternative to templateCssUrl. Maximum 200KB. Discouraged for large CSS because the LLM may summarize it: prefer templateCssUrl."),
    templateMarpUrl: z
      .string()
      .nullable()
      .describe("Only template='marp-custom': public HTTPS URL the tool downloads the Marp+Mustache template from. Mutually exclusive with templateMarp. Must start with https://. Cached in memory for the lifetime of the process."),
    templateCssUrl: z
      .string()
      .nullable()
      .describe("Only template='marp-custom': public HTTPS URL the tool downloads the theme CSS from. Mutually exclusive with templateCss. Must start with https://. Cached in memory."),
    templateData: z
      .string()
      .nullable()
      .describe("Only template='marp-custom': serialized JSON string with the data for Mustache. Must parse to a flat key/value object. Example: '{\"customer_name\":\"Jane Doe\",\"title\":\"...\"}'."),
  }),
    execute: async (
      params: {
        markdown: string;
        filename: string;
        headerImageUrl: string | null;
        template: "default" | "enterprise" | "marp-custom" | null;
        brandAccentHex: string | null;
        brandLogoUrl: string | null;
        documentTitle: string | null;
        documentSubtitle: string | null;
        brandFooterText: string | null;
        documentDate: string | null;
        templateMarp: string | null;
        templateCss: string | null;
        templateMarpUrl: string | null;
        templateCssUrl: string | null;
        templateData: string | null;
      },
      ctx,
    ) => {
      const template = params.template ?? "default";

      // For marp-custom the `markdown` field is unused — the template comes from templateMarp.
      if (template !== "marp-custom" && params.markdown.length > MAX_MARKDOWN_LENGTH) {
        return {
          error: `Markdown too long: ${params.markdown.length} characters (max ${MAX_MARKDOWN_LENGTH}).`,
        };
      }
      if (params.headerImageUrl && !/^https:\/\//.test(params.headerImageUrl)) {
        return { error: "headerImageUrl must be an absolute https:// URL." };
      }

      try {
        let buffer: Buffer;

        if (template === "marp-custom") {
          // Resolve templateMarp from inline or URL (URL preferred, larger payloads).
          let resolvedTemplateMarp: string | null = null;
          if (params.templateMarp && params.templateMarp.trim().length > 0) {
            if (params.templateMarp.length > MAX_TEMPLATE_LENGTH) {
              return { error: `templateMarp too long: ${params.templateMarp.length} characters (max ${MAX_TEMPLATE_LENGTH}).` };
            }
            resolvedTemplateMarp = params.templateMarp;
          } else if (params.templateMarpUrl && params.templateMarpUrl.trim().length > 0) {
            if (!/^https:\/\//.test(params.templateMarpUrl)) {
              return { error: "templateMarpUrl must be an absolute https:// URL." };
            }
            resolvedTemplateMarp = await resolveTextTemplate(params.templateMarpUrl);
            if (!resolvedTemplateMarp) {
              return { error: `templateMarpUrl fetch failed or template is empty: ${params.templateMarpUrl}` };
            }
          } else {
            return { error: "template='marp-custom' requires templateMarp inline OR templateMarpUrl." };
          }

          // Resolve templateCss from inline or URL.
          let resolvedTemplateCss: string | null = null;
          if (params.templateCss && params.templateCss.trim().length > 0) {
            if (params.templateCss.length > MAX_TEMPLATE_LENGTH) {
              return { error: `templateCss too long: ${params.templateCss.length} characters (max ${MAX_TEMPLATE_LENGTH}).` };
            }
            resolvedTemplateCss = params.templateCss;
          } else if (params.templateCssUrl && params.templateCssUrl.trim().length > 0) {
            if (!/^https:\/\//.test(params.templateCssUrl)) {
              return { error: "templateCssUrl must be an absolute https:// URL." };
            }
            resolvedTemplateCss = await resolveTextTemplate(params.templateCssUrl);
            if (!resolvedTemplateCss) {
              return { error: `templateCssUrl fetch failed or CSS is empty: ${params.templateCssUrl}` };
            }
          } else {
            return { error: "template='marp-custom' requires templateCss inline OR templateCssUrl." };
          }

          if (!params.templateData || params.templateData.trim().length === 0) {
            return { error: "template='marp-custom' requires a non-empty templateData." };
          }
          const parsed = parseTemplateData(params.templateData);
          if (!parsed.ok) {
            return { error: `templateData ${parsed.error}` };
          }
          buffer = await generateMarpPdfBuffer({
            templateMarp: resolvedTemplateMarp,
            templateCss: resolvedTemplateCss,
            dataObj: parsed.value,
          });
        } else if (template === "enterprise") {
          if (!params.brandAccentHex || !HEX_COLOR_RE.test(params.brandAccentHex)) {
            return { error: "brandAccentHex must be a 6-digit hex code (e.g. '#F16034')." };
          }
          if (params.brandLogoUrl && !/^https:\/\//.test(params.brandLogoUrl)) {
            return { error: "brandLogoUrl must be an absolute https:// URL." };
          }
          const titleFromMarkdown = (params.markdown.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
          const resolvedTitle = params.documentTitle ?? titleFromMarkdown;
          if (!resolvedTitle) {
            return { error: "template='enterprise' requires documentTitle (or an H1 in the markdown to derive it from)." };
          }
          buffer = await generateEnterprisePdfBuffer({
            markdown: params.markdown,
            brandAccentHex: params.brandAccentHex,
            brandLogoUrl: params.brandLogoUrl,
            documentTitle: resolvedTitle,
            documentSubtitle: params.documentSubtitle,
            brandFooterText: params.brandFooterText,
            documentDate: params.documentDate,
          });
        } else {
          buffer = await generatePdfBuffer(params.markdown, params.headerImageUrl ?? undefined);
        }

        if (buffer.length > MAX_PDF_SIZE_BYTES) {
          return {
            error: `Generated PDF too large: ${buffer.length} bytes (max ${MAX_PDF_SIZE_BYTES}).`,
          };
        }

        const filename = sanitizeFilename(params.filename);
        // The bytes stay in the engine; the model only ever sees the handle.
        const fileHandle = await ctx.artifacts.put({
          buffer,
          filename,
          mime: "application/pdf",
        });

        return {
          success: true,
          fileHandle,
          filename,
          sizeBytes: buffer.length,
          message:
            "PDF generated. Pass fileHandle to a tool that uploads files (e.g. hubspot:file) within 10 minutes.",
        };
      } catch (err) {
        return { error: `PDF generation error: ${errMsg(err)}` };
      }
    },
});
