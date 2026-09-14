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
    "Genera un PDF A4 a partire da contenuto Markdown.\n" +
    "Accetta GFM-style tables, liste, code blocks, link, immagini, blockquote.\n" +
    "Opzionalmente accetta headerImageUrl: un URL https:// pubblico (es. logo aziendale) che viene renderizzato come PRIMO elemento del documento, allineato a destra, prima del contenuto Markdown. Visibile sulla prima pagina.\n" +
    "Per output enterprise (cover page, brand colors, header/footer con paginazione) passa template=\"enterprise\" + brandAccentHex + brandLogoUrl + documentTitle.\n" +
    "Restituisce un pdfHandle opaco (valido per 10 minuti) consumabile da tool successivi (es. hubspotFile) per evitare di passare il binario tra tool call.\n" +
    "Limite input: 100KB di markdown. Limite output: 10MB.",
  category: "document",
  inputExamples: [
    {
      label: "Riepilogo preventivo (default)",
      input: {
        markdown: "# Preventivo n. 2026-001\n\n**Cliente:** Mario Rossi\n\n| Voce | Importo |\n|---|---|\n| Servizio A | €100 |\n| Servizio B | €250 |\n\n**Totale: €350**",
        filename: "preventivo-2026-001",
        headerImageUrl: null,
      },
    },
    {
      label: "Proposta con logo aziendale in header (default)",
      input: {
        markdown: "# Proposta\n\nGentile Cliente,\n\nin allegato la proposta.",
        filename: "proposta-cliente",
        headerImageUrl: "https://cdn.example.com/logo.png",
      },
    },
    {
      label: "Documento enterprise con cover, brand e paginazione",
      input: {
        markdown: "# Sezione 1\n\nContenuto della prima sezione.\n\n# Sezione 2\n\nContenuto della seconda sezione.",
        filename: "documento-enterprise",
        template: "enterprise",
        brandAccentHex: "#F16034",
        brandLogoUrl: "https://cdn.example.com/logo.png",
        documentTitle: "Titolo del documento",
        documentSubtitle: "Preparato per Mario Rossi · Maggio 2026",
        brandFooterText: "Acme Srl · acme.com",
        documentDate: "Milano, 15 maggio 2026",
      },
    },
    {
      label: "Template Marp+Mustache custom passato dal chiamante (inline)",
      input: {
        markdown: "n/a",
        filename: "documento-marp",
        template: "marp-custom",
        templateMarp: "---\nmarp: true\ntheme: custom-a\nsize: A4\nhtml: true\n---\n# {{titolo}}\n\nCiao **{{nome}}**.",
        templateCss: "/* @theme custom-a */\nsection { background: #FFF; color: #111; padding: 20mm; font-family: sans-serif; }",
        templateData: "{\"titolo\":\"Esempio\",\"nome\":\"Mario Rossi\"}",
      },
    },
    {
      label: "Template Marp custom da URL (preferito per template >5KB)",
      input: {
        markdown: "n/a",
        filename: "documento-marp-url",
        template: "marp-custom",
        templateMarpUrl: "https://cdn.example.com/template.md",
        templateCssUrl: "https://cdn.example.com/theme.css",
        templateData: "{\"titolo\":\"Esempio\",\"nome\":\"Mario Rossi\"}",
      },
    },
  ],
  parameters: z.object({
    markdown: z
      .string()
      .min(1)
      .describe("Contenuto Markdown da convertire in PDF. Supporta GFM (tabelle, code blocks)."),
      filename: z
        .string()
        .min(1)
        .describe("Nome file desiderato senza estensione (es. 'preventivo-mario-rossi'). Estensione .pdf aggiunta automaticamente. Caratteri non sicuri sostituiti con '-'."),
      headerImageUrl: z
        .string()
        .nullable()
        .describe("Opzionale: URL HTTPS pubblico di un'immagine (es. logo aziendale) da mostrare come primo elemento del documento, allineata a destra, prima del contenuto Markdown. Visibile sulla prima pagina. Deve iniziare con https://. Se null, nessun logo. Ignorato quando template='enterprise' (usa brandLogoUrl)."),
      template: z
        .enum(["default", "enterprise", "marp-custom"])
        .nullable()
        .describe("Stile grafico. 'default' o null = stile base attuale. 'enterprise' = cover page + brand colors + header/footer con paginazione (richiede brandAccentHex, brandLogoUrl, documentTitle). 'marp-custom' = template Marp+Mustache arbitrario passato dal chiamante (richiede templateMarp, templateCss, templateData)."),
      brandAccentHex: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': colore accent in formato hex 6 cifre (es. '#0066CC' o '#F16034'). Iniettato come CSS custom property --brand-accent (divisore cover, border-left H1, table header). Validato runtime."),
      brandLogoUrl: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': URL HTTPS del logo aziendale. Logo grande nella cover, piccolo nell'header pagine 2+. Deve iniziare con https://."),
      documentTitle: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': titolo principale mostrato nella cover (es. 'Blueprint della proposta'). Anche mostrato nell'header pagine 2+. Se null, fallback al primo H1 del markdown."),
      documentSubtitle: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': sottotitolo cover (es. 'Preparato per Mario Rossi · Maggio 2026'). Se null, nessun sottotitolo."),
      brandFooterText: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': testo del footer pagine 2+ (es. 'Exelab · polyant.ai' o 'Acme Srl · acme.com'). Se null, footer mostra solo la numerazione pagine."),
      documentDate: z
        .string()
        .nullable()
        .describe("Solo template='enterprise': data mostrata in basso nella cover (es. 'Milano, 15 maggio 2026'). Se null, viene generata oggi in italiano senza prefisso citta."),
      templateMarp: z
        .string()
        .nullable()
        .describe("Solo template='marp-custom': template Marp+Mustache passato inline. Alternativa a templateMarpUrl. Massimo 200KB. Sconsigliato per template grandi: l'LLM può tagliarli — preferire templateMarpUrl."),
      templateCss: z
        .string()
        .nullable()
        .describe("Solo template='marp-custom': theme CSS passato inline. Alternativa a templateCssUrl. Massimo 200KB. Sconsigliato per CSS grandi: l'LLM può sintetizzarli — preferire templateCssUrl."),
      templateMarpUrl: z
        .string()
        .nullable()
        .describe("Solo template='marp-custom': URL HTTPS pubblico da cui il tool scarica il template Marp+Mustache. Esclusivo con templateMarp. Deve iniziare con https://. Cachato in memoria per la durata del processo."),
      templateCssUrl: z
        .string()
        .nullable()
        .describe("Solo template='marp-custom': URL HTTPS pubblico da cui il tool scarica il theme CSS. Esclusivo con templateCss. Deve iniziare con https://. Cachato in memoria."),
      templateData: z
        .string()
        .nullable()
        .describe("Solo template='marp-custom': JSON string serializzato con i dati per Mustache. Deve parsare a un oggetto piatto chiave/valore. Esempio: '{\"cliente_nome\":\"Mario Rossi\",\"titolo\":\"...\"}'."),
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
          error: `Markdown troppo lungo: ${params.markdown.length} caratteri (max ${MAX_MARKDOWN_LENGTH}).`,
        };
      }
      if (params.headerImageUrl && !/^https:\/\//.test(params.headerImageUrl)) {
        return { error: "headerImageUrl deve essere un URL https:// assoluto." };
      }

      try {
        let buffer: Buffer;

        if (template === "marp-custom") {
          // Resolve templateMarp from inline or URL (URL preferred, larger payloads).
          let resolvedTemplateMarp: string | null = null;
          if (params.templateMarp && params.templateMarp.trim().length > 0) {
            if (params.templateMarp.length > MAX_TEMPLATE_LENGTH) {
              return { error: `templateMarp troppo lungo: ${params.templateMarp.length} caratteri (max ${MAX_TEMPLATE_LENGTH}).` };
            }
            resolvedTemplateMarp = params.templateMarp;
          } else if (params.templateMarpUrl && params.templateMarpUrl.trim().length > 0) {
            if (!/^https:\/\//.test(params.templateMarpUrl)) {
              return { error: "templateMarpUrl deve essere un URL https:// assoluto." };
            }
            resolvedTemplateMarp = await resolveTextTemplate(params.templateMarpUrl);
            if (!resolvedTemplateMarp) {
              return { error: `templateMarpUrl fetch fallito o template vuoto: ${params.templateMarpUrl}` };
            }
          } else {
            return { error: "Per template='marp-custom' serve templateMarp inline OPPURE templateMarpUrl." };
          }

          // Resolve templateCss from inline or URL.
          let resolvedTemplateCss: string | null = null;
          if (params.templateCss && params.templateCss.trim().length > 0) {
            if (params.templateCss.length > MAX_TEMPLATE_LENGTH) {
              return { error: `templateCss troppo lungo: ${params.templateCss.length} caratteri (max ${MAX_TEMPLATE_LENGTH}).` };
            }
            resolvedTemplateCss = params.templateCss;
          } else if (params.templateCssUrl && params.templateCssUrl.trim().length > 0) {
            if (!/^https:\/\//.test(params.templateCssUrl)) {
              return { error: "templateCssUrl deve essere un URL https:// assoluto." };
            }
            resolvedTemplateCss = await resolveTextTemplate(params.templateCssUrl);
            if (!resolvedTemplateCss) {
              return { error: `templateCssUrl fetch fallito o CSS vuoto: ${params.templateCssUrl}` };
            }
          } else {
            return { error: "Per template='marp-custom' serve templateCss inline OPPURE templateCssUrl." };
          }

          if (!params.templateData || params.templateData.trim().length === 0) {
            return { error: "Per template='marp-custom' serve templateData non vuoto." };
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
            return { error: "brandAccentHex deve essere un hex code a 6 cifre (es. '#F16034')." };
          }
          if (params.brandLogoUrl && !/^https:\/\//.test(params.brandLogoUrl)) {
            return { error: "brandLogoUrl deve essere un URL https:// assoluto." };
          }
          const titleFromMarkdown = (params.markdown.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
          const resolvedTitle = params.documentTitle ?? titleFromMarkdown;
          if (!resolvedTitle) {
            return { error: "Per template='enterprise' serve documentTitle (oppure un H1 nel markdown da cui derivarlo)." };
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
            error: `PDF generato troppo grande: ${buffer.length} byte (max ${MAX_PDF_SIZE_BYTES}).`,
          };
        }

        const filename = sanitizeFilename(params.filename);
        // The bytes stay in the engine; the model only ever sees the handle.
        const fileHandle = ctx.artifacts.put({
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
            "PDF generato. Passa fileHandle a un tool che carica file (es. hubspot:file) entro 10 minuti.",
        };
      } catch (err) {
        return { error: `Errore generazione PDF: ${errMsg(err)}` };
      }
    },
});
