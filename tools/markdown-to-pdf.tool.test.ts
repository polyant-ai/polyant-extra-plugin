// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import markdownToPdfTool, { Semaphore } from "./markdown-to-pdf.tool.js";
import type { ToolContext } from "@polyant-ai/plugin-sdk";
import { createMockAudit, createMockArtifacts } from "../lib/test-utils.js";

// Pause a microtask so any pending acquire() Promises get a chance to run.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Semaphore", () => {
  it("rejects non-positive permits", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it("acquire returns immediately while permits are available", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.stats()).toEqual({ available: 0, capacity: 2, waiting: 0 });
  });

  it("blocks beyond capacity and resumes on release (FIFO)", async () => {
    const s = new Semaphore(2);
    const completed: number[] = [];

    const task = async (id: number) => {
      await s.acquire();
      completed.push(id);
    };

    void task(1);
    void task(2);
    void task(3);
    void task(4);

    await tick();
    // Only the first 2 should have made it past acquire().
    expect(completed).toEqual([1, 2]);
    expect(s.stats().waiting).toBe(2);

    // Release one — task(3) wakes.
    s.release();
    await tick();
    expect(completed).toEqual([1, 2, 3]);
    expect(s.stats().waiting).toBe(1);

    // Release another — task(4) wakes.
    s.release();
    await tick();
    expect(completed).toEqual([1, 2, 3, 4]);
    expect(s.stats().waiting).toBe(0);
  });

  it("recovers the permit when the critical section throws (try/finally)", async () => {
    const s = new Semaphore(1);

    async function critical(shouldThrow: boolean): Promise<void> {
      await s.acquire();
      try {
        if (shouldThrow) throw new Error("boom");
      } finally {
        s.release();
      }
    }

    await expect(critical(true)).rejects.toThrow("boom");
    // Permit must be free again — otherwise the second call would hang.
    expect(s.stats().available).toBe(1);
    await critical(false);
    expect(s.stats().available).toBe(1);
  });

  it("release without contention never overshoots capacity", () => {
    const s = new Semaphore(2);
    // Spurious releases (defensive — never expected in practice) must not
    // push `available` above `capacity`.
    s.release();
    s.release();
    s.release();
    s.release();
    expect(s.stats().available).toBe(2);
  });

  it("caps real concurrent operations (integration-style)", async () => {
    const s = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function run() {
      await s.acquire();
      try {
        active++;
        if (active > peak) peak = active;
        await wait(20);
      } finally {
        active--;
        s.release();
      }
    }

    await Promise.all(Array.from({ length: 10 }, () => run()));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // sanity: some parallelism happened
    expect(active).toBe(0);
    expect(s.stats()).toEqual({ available: 3, capacity: 3, waiting: 0 });
  });
});

function stubCtx(): ToolContext {
  return {
    instanceId: "markdown-to-pdf-test" as never,
    memoryScopeKey: "",
    secrets: {},
    audit: createMockAudit(),
    artifacts: createMockArtifacts(),
    conversationId: "markdown-to-pdf-test-conv",
    attachments: [],
    provider: "openai",
  };
}

async function executeTool(input: Record<string, unknown>) {
  // Straight at the default export: boot discovery is the engine's job, and
  // what this file exercises is the tool's own input handling.
  return markdownToPdfTool.execute(input as never, stubCtx()) as Promise<
    Record<string, unknown>
  >;
}

describe("markdownToPdf — input validation", () => {
  it("rejects template='enterprise' without brandAccentHex", async () => {
    const result = await executeTool({
      markdown: "# Test",
      filename: "test",
      headerImageUrl: null,
      template: "enterprise",
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: "Test",
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
    });
    expect(result.error).toContain("brandAccentHex");
  });

  it("rejects malformed brandAccentHex", async () => {
    const result = await executeTool({
      markdown: "# Test",
      filename: "test",
      headerImageUrl: null,
      template: "enterprise",
      brandAccentHex: "#XYZ123",
      brandLogoUrl: null,
      documentTitle: "Test",
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
    });
    expect(result.error).toContain("hex");
  });

  it("rejects non-https brandLogoUrl", async () => {
    const result = await executeTool({
      markdown: "# Test",
      filename: "test",
      headerImageUrl: null,
      template: "enterprise",
      brandAccentHex: "#F16034",
      brandLogoUrl: "http://insecure.example.com/logo.png",
      documentTitle: "Test",
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
    });
    expect(result.error).toContain("https");
  });

  it("rejects enterprise without documentTitle and without H1 in markdown", async () => {
    const result = await executeTool({
      markdown: "Body without any heading.",
      filename: "test",
      headerImageUrl: null,
      template: "enterprise",
      brandAccentHex: "#F16034",
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
    });
    expect(result.error).toContain("documentTitle");
  });

  it("rejects markdown over the size cap", async () => {
    const result = await executeTool({
      markdown: "x".repeat(100_001),
      filename: "test",
      headerImageUrl: null,
      template: null,
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
      templateMarp: null,
      templateCss: null,
      templateMarpUrl: null,
      templateCssUrl: null,
      templateData: null,
    });
    expect(result.error).toContain("Markdown too long");
  });

  it("template='marp-custom' rejects missing templateMarp", async () => {
    const result = await executeTool({
      markdown: "",
      filename: "test",
      headerImageUrl: null,
      template: "marp-custom",
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
      templateMarp: null,
      templateCss: "/* @theme x */\nsection { padding: 10mm; }",
      templateMarpUrl: null,
      templateCssUrl: null,
      templateData: "{}",
    });
    expect(result.error).toContain("templateMarp");
  });

  it("template='marp-custom' rejects missing templateCss", async () => {
    const result = await executeTool({
      markdown: "",
      filename: "test",
      headerImageUrl: null,
      template: "marp-custom",
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
      templateMarp: "---\nmarp: true\n---\n# x",
      templateCss: null,
      templateMarpUrl: null,
      templateCssUrl: null,
      templateData: "{}",
    });
    expect(result.error).toContain("templateCss");
  });

  it("template='marp-custom' rejects malformed templateData JSON", async () => {
    const result = await executeTool({
      markdown: "",
      filename: "test",
      headerImageUrl: null,
      template: "marp-custom",
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
      templateMarp: "---\nmarp: true\n---\n# x",
      templateCss: "/* @theme x */\nsection { padding: 10mm; }",
      templateMarpUrl: null,
      templateCssUrl: null,
      templateData: "{ not json }",
    });
    expect(result.error).toContain("templateData");
    expect(result.error).toContain("JSON malformato");
  });

  it("template='marp-custom' rejects non-object templateData", async () => {
    const result = await executeTool({
      markdown: "",
      filename: "test",
      headerImageUrl: null,
      template: "marp-custom",
      brandAccentHex: null,
      brandLogoUrl: null,
      documentTitle: null,
      documentSubtitle: null,
      brandFooterText: null,
      documentDate: null,
      templateMarp: "---\nmarp: true\n---\n# x",
      templateCss: "/* @theme x */\nsection { padding: 10mm; }",
      templateMarpUrl: null,
      templateCssUrl: null,
      templateData: '"just a string"',
    });
    expect(result.error).toContain("templateData");
  });
});
