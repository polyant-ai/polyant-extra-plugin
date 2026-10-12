// SPDX-License-Identifier: AGPL-3.0-or-later

import { Marp } from "@marp-team/marp-core";
import Mustache from "mustache";

const PRINT_PAGE_BREAK_CSS = `
@media print {
  section { page-break-after: always; }
  section:last-of-type { page-break-after: auto; }
}
`;

export interface MarpTemplateInput {
  templateMarp: string;
  templateCss: string;
  dataObj: Record<string, unknown>;
}

export interface MarpRenderResult {
  bodyHtml: string;
}

/**
 * Generic Marp + Mustache renderer.
 *
 * Pure utility: knows nothing about brand, instance, or copy. Takes a Marp
 * template string with Mustache placeholders, a theme CSS string, and a
 * data object. Returns a self-contained HTML document ready to feed to
 * puppeteer for PDF generation.
 *
 * Pipeline: Mustache.render(template, data) -> Marp.render(markdown) -> HTML.
 *
 * The `html: true` flag lets the template embed arbitrary inline HTML
 * (e.g. <div class="page-wrap">). Mustache HTML-escapes data values by
 * default — use {{{var}}} (triple-stache) inside the template only when
 * the field is known-safe HTML (e.g. a data URI).
 */
export function renderMarpHtml({
  templateMarp,
  templateCss,
  dataObj,
}: MarpTemplateInput): MarpRenderResult {
  if (!templateMarp || templateMarp.trim().length === 0) {
    throw new Error("renderMarpHtml: templateMarp is required");
  }
  if (!templateCss || templateCss.trim().length === 0) {
    throw new Error("renderMarpHtml: templateCss is required");
  }

  const markdownFinal = Mustache.render(templateMarp, dataObj);

  const marp = new Marp({ html: true });
  marp.themeSet.add(templateCss);

  const { html, css } = marp.render(markdownFinal);

  const bodyHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}\n${PRINT_PAGE_BREAK_CSS}</style></head><body>${html}</body></html>`;

  return { bodyHtml };
}

export interface JsonParseResult {
  ok: true;
  value: Record<string, unknown>;
}

export interface JsonParseError {
  ok: false;
  error: string;
}

/**
 * Parses a JSON string into a flat record. Used by callers (the tool) that
 * receive `templateData` as a serialized JSON string from an LLM. Returns
 * a discriminated union so the caller can produce a friendly error
 * message instead of throwing.
 */
export function parseTemplateData(input: string): JsonParseResult | JsonParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return { ok: false, error: `JSON malformato: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON must be an object (key/value), not an array or a primitive" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
