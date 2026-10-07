// SPDX-License-Identifier: AGPL-3.0-or-later

const mockS3Send = vi.hoisted(() => vi.fn());
// Every config an S3Client was constructed with, so a test can prove which
// credentials reached the client (or that no client was built at all).
const s3ClientArgs = vi.hoisted(() => ({ all: [] as any[] }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@polyant-ai/plugin-sdk";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    send = mockS3Send;
    constructor(cfg: unknown) {
      s3ClientArgs.all.push(cfg);
    }
  },
  PutObjectCommand: class MockPutObjectCommand {
    constructor(public params: Record<string, unknown>) {}
  },
}));

import def from "./file-upload.tool.js";
import { buildTool, createMockArtifacts, createMockAudit } from "../lib/test-utils.js";

const DEFAULT_SECRETS = {
  aws_access_key_id: "static-access-key-id",
  aws_secret_access_key: "static-secret-access-key",
  aws_region: "eu-west-1",
  s3_bucket_name: "test-bucket",
};

const NO_INPUT = { attachmentIndex: null, base64Data: null, mimeType: null, filename: null };
const FIRST_ATTACHMENT = { ...NO_INPUT, attachmentIndex: 0 };

function createMockState(): NonNullable<ToolContext["state"]> {
  const store = new Map<string, unknown>();
  return {
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    getAll: () => Object.fromEntries(store),
    delete: (k) => void store.delete(k),
    channel: undefined,
  };
}

function setup(opts?: { secrets?: Record<string, string>; attachments?: any[]; withState?: boolean }) {
  const ctx = {
    instanceId: "test-instance",
    secrets: opts?.secrets ?? DEFAULT_SECRETS,
    audit: createMockAudit(),
    conversationId: "conv-1",
    attachments: opts?.attachments,
    state: opts?.withState ? createMockState() : undefined,
    artifacts: createMockArtifacts(),
  } as unknown as ToolContext;
  const tool = buildTool(def, ctx);
  return { execute: (input: unknown) => tool.execute(input) as Promise<any>, ctx };
}

const png = (fileName?: string) => ({ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName });

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
  s3ClientArgs.all = [];
});

describe("fileUpload tool", () => {
  it("registers with the static-credential secrets only, all required", () => {
    expect(def.name).toBe("fileUpload");
    expect(def.category).toBe("storage");
    expect(def.requiredSecrets.map((s) => s.key)).toEqual([
      "s3_bucket_name",
      "aws_region",
      "aws_access_key_id",
      "aws_secret_access_key",
    ]);
    for (const spec of def.requiredSecrets) expect(spec.optional).toBeFalsy();
    expect(def.requiredSecrets.find((s) => s.key === "aws_secret_access_key")?.sensitive).toBe(true);
  });

  it("uploads an attachment under {instanceId}/{conversationId}/{filename}", async () => {
    const { execute } = setup({
      attachments: [{ type: "image", data: Buffer.from("fake-image"), mimeType: "image/jpeg", fileName: "photo.jpg" }],
    });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result).toEqual({
      status: "ok",
      key: "test-instance/conv-1/photo.jpg",
      url: "https://test-bucket.s3.eu-west-1.amazonaws.com/test-instance/conv-1/photo.jpg",
      sizeBytes: Buffer.from("fake-image").length,
    });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].params).toMatchObject({
      Bucket: "test-bucket",
      Key: "test-instance/conv-1/photo.jpg",
      ContentType: "image/jpeg",
    });
  });

  it("uploads base64 data", async () => {
    const data = Buffer.from("hello-world");
    const { execute } = setup();

    const result = await execute({ ...NO_INPUT, base64Data: data.toString("base64"), mimeType: "application/pdf", filename: "doc.pdf" });

    expect(result.key).toBe("test-instance/conv-1/doc.pdf");
    expect(result.sizeBytes).toBe(data.length);
  });

  it("uses a custom filename when provided", async () => {
    const { execute } = setup({ attachments: [png("original.png")] });

    const result = await execute({ ...FIRST_ATTACHMENT, filename: "custom-name.png" });

    expect(result.key).toBe("test-instance/conv-1/custom-name.png");
  });

  it("generates a UUID filename with the MIME extension when none is given", async () => {
    const { execute } = setup({ attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" }] });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.key).toMatch(/^test-instance\/conv-1\/[0-9a-f-]{36}\.jpg$/);
  });

  it("strips path separators so a filename cannot leave the conversation prefix", async () => {
    const { execute } = setup({ attachments: [png()] });

    const result = await execute({ ...FIRST_ATTACHMENT, filename: "../other-agent\\x.png" });

    expect(result.key).toBe("test-instance/conv-1/.._other-agent_x.png");
  });

  it("uses 'unknown' as the conversation segment when the engine gives none", async () => {
    const { execute, ctx } = setup({ attachments: [png("a.png")] });
    (ctx as any).conversationId = undefined;

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.key).toBe("test-instance/unknown/a.png");
  });

  it("returns an error when no file is provided", async () => {
    const { execute } = setup();
    const result = await execute(NO_INPUT);
    expect(result).toMatchObject({ status: "error" });
    expect(result.error).toContain("No file provided");
  });

  it("returns an error for an attachment index that does not exist", async () => {
    const { execute } = setup({ attachments: [] });
    const result = await execute(FIRST_ATTACHMENT);
    expect(result.error).toContain("No attachment found");
  });

  it("returns an error when the attachment has no binary data", async () => {
    const { execute } = setup({ attachments: [{ type: "image", mimeType: "image/jpeg", fileName: "photo.jpg" }] });
    const result = await execute(FIRST_ATTACHMENT);
    expect(result.error).toContain("has no binary data");
  });

  it("rejects files larger than 10 MB without contacting S3", async () => {
    const { execute } = setup({
      attachments: [{ type: "file", data: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: "application/pdf" }],
    });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result).toMatchObject({ status: "error" });
    expect(result.error).toContain("File too large");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("accepts a file of exactly 10 MB", async () => {
    const { execute } = setup({
      attachments: [{ type: "file", data: Buffer.alloc(10 * 1024 * 1024), mimeType: "application/pdf", fileName: "max.pdf" }],
    });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.status).toBe("ok");
  });

  it("builds the S3 client with the agent's static credentials and region", async () => {
    const { execute } = setup({ attachments: [png("a.png")] });

    await execute(FIRST_ATTACHMENT);

    expect(s3ClientArgs.all).toHaveLength(1);
    expect(s3ClientArgs.all[0].region).toBe("eu-west-1");
    expect(s3ClientArgs.all[0].credentials).toEqual({
      accessKeyId: "static-access-key-id",
      secretAccessKey: "static-secret-access-key",
    });
    expect(s3ClientArgs.all[0].endpoint).toBeUndefined();
  });

  it.each([
    ["s3_bucket_name"],
    ["aws_region"],
    ["aws_access_key_id"],
    ["aws_secret_access_key"],
  ])("returns not_configured naming %s when it is missing, and never builds a client", async (key) => {
    const secrets: Record<string, string> = { ...DEFAULT_SECRETS };
    delete secrets[key];
    const { execute, ctx } = setup({ secrets, attachments: [png("a.png")] });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.status).toBe("not_configured");
    expect(result.error).toContain(key);
    expect(s3ClientArgs.all).toHaveLength(0);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "storage.fileUpload", success: false }));
  });

  it("treats blank secrets as missing", async () => {
    const { execute } = setup({ secrets: { ...DEFAULT_SECRETS, aws_secret_access_key: "   " }, attachments: [png("a.png")] });
    const result = await execute(FIRST_ATTACHMENT);
    expect(result.status).toBe("not_configured");
    expect(s3ClientArgs.all).toHaveLength(0);
  });

  it("ignores the retired s3_use_task_role secret", async () => {
    const { execute } = setup({
      secrets: { s3_bucket_name: "b", aws_region: "eu-west-1", s3_use_task_role: "true" },
      attachments: [png("a.png")],
    });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.status).toBe("not_configured");
    expect(s3ClientArgs.all).toHaveLength(0);
  });

  describe("with ambient AWS credentials in the process environment", () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.AWS_ACCESS_KEY_ID = "deployment-key";
      process.env.AWS_SECRET_ACCESS_KEY = "deployment-secret";
      process.env.AWS_REGION = "us-east-1";
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it("does not fall back to them when the agent has no keys", async () => {
      const { execute } = setup({ secrets: { s3_bucket_name: "b", aws_region: "eu-west-1" }, attachments: [png("a.png")] });

      const result = await execute(FIRST_ATTACHMENT);

      expect(result.status).toBe("not_configured");
      expect(s3ClientArgs.all).toHaveLength(0);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it("uses the agent's keys, never the deployment's, when both exist", async () => {
      const { execute } = setup({ attachments: [png("a.png")] });

      await execute(FIRST_ATTACHMENT);

      expect(s3ClientArgs.all[0].credentials).toEqual({
        accessKeyId: "static-access-key-id",
        secretAccessKey: "static-secret-access-key",
      });
      expect(s3ClientArgs.all[0].region).toBe("eu-west-1");
    });
  });

  it("returns an error and audits the failure when S3 rejects the upload", async () => {
    mockS3Send.mockRejectedValue(new Error("S3 PutObject failed"));
    const { execute, ctx } = setup({ attachments: [png("a.png")], withState: true });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result).toEqual({ status: "error", error: "S3 PutObject failed" });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "storage.fileUpload", success: false, error: "S3 PutObject failed" }),
    );
    expect(ctx.state!.get("lastUploadedFile")).toBeUndefined();
  });

  it("audits a successful upload with bucket, key and size", async () => {
    const { execute, ctx } = setup({ attachments: [png("a.png")] });

    await execute(FIRST_ATTACHMENT);

    expect(ctx.audit.log).toHaveBeenCalledWith({
      action: "storage.fileUpload",
      details: { bucket: "test-bucket", key: "test-instance/conv-1/a.png", sizeBytes: 3, mimeType: "image/png" },
      success: true,
    });
  });

  it("writes the uploaded file to conversation state on success", async () => {
    const { execute, ctx } = setup({
      attachments: [{ type: "image", data: Buffer.from("fake-image"), mimeType: "image/jpeg", fileName: "bolletta.jpg" }],
      withState: true,
    });

    await execute(FIRST_ATTACHMENT);

    expect(ctx.state!.get("lastUploadedFile")).toEqual({
      key: "test-instance/conv-1/bolletta.jpg",
      url: "https://test-bucket.s3.eu-west-1.amazonaws.com/test-instance/conv-1/bolletta.jpg",
      sizeBytes: Buffer.from("fake-image").length,
      mimeType: "image/jpeg",
    });
  });

  it("percent-encodes the filename in the returned URL and keeps the raw key", async () => {
    const { execute } = setup({
      attachments: [{ type: "file", data: Buffer.from("x"), mimeType: "application/pdf", fileName: "a b#c?.pdf" }],
    });

    const result = await execute(FIRST_ATTACHMENT);

    expect(result.key).toBe("test-instance/conv-1/a b#c?.pdf");
    expect(result.url).toContain("/test-instance/conv-1/a%20b%23c%3F.pdf");
    expect(result.url).not.toContain("#");
    expect(result.url).not.toContain("?");
  });
});
