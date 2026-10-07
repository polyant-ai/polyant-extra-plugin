# polyant-extra-plugin

Tools that are useful but not part of every Polyant deployment, kept out of the
engine image so nothing pays for them by default.

## Tools

The plugin namespace is `extra`, so the engine registers each tool as
`extra:<name>`.

| Tool | What it does |
| --- | --- |
| `extra:markdownToPdf` | render Markdown to PDF (default, enterprise-branded, or a custom Marp template) and return a handle to the bytes |
| `extra:fileUpload` | upload a current message attachment or base64 data (max 10 MB) to the agent's S3 bucket and return its key and URL |

## Why it is a plugin

`markdownToPdf` is the only thing in the product that needs a browser. Keeping it in the
engine meant every image carried `puppeteer`, Alpine's `chromium` and its font
and rendering libraries — about 300MB and a large attack surface — whether or not
the deployment ever rendered a page.

## System requirements

`plugin.json` declares what the runtime image needs:

```json
"system": {
  "apk": ["chromium", "nss", "freetype", "harfbuzz", "ca-certificates", "ttf-freefont", "font-noto-emoji"],
  "env": {
    "PUPPETEER_SKIP_DOWNLOAD": "true",
    "PUPPETEER_EXECUTABLE_PATH": "/usr/bin/chromium-browser"
  }
}
```

The engine's `Dockerfile.engine` collects these from every included plugin and
installs them in the runtime stage. Puppeteer's own bundled Chromium is a glibc
build that cannot run on Alpine, which is why the download is skipped and the
executable path points at the distro package.

`PDF_CONCURRENCY` (default 3, range 1–32) caps parallel renders. Each one holds a
Chromium page at roughly 50–100MB, so it is a memory bound rather than a
throughput setting.

## S3 credentials for `extra:fileUpload`

The tool reads four agent secrets, all required: `s3_bucket_name`, `aws_region`,
`aws_access_key_id` and `aws_secret_access_key`. They are the names the engine's
former `fileUpload` used, so an agent that had it configured only needs
`extra:fileUpload` enabled in place of `fileUpload`.

The S3 client is always built with those static keys. There is no task-role mode
and no fallback to the AWS default provider chain, so an agent can never act with
the deployment's own identity: when a key is missing the tool returns
`not_configured` and sends nothing. Files go under
`{instanceId}/{conversationId}/{filename}`, and the latest upload is kept in
conversation state as `lastUploadedFile`.

## The file handoff

`extra:markdownToPdf` returns `fileHandle`, not bytes. The PDF lives in the
engine's artifact store, bound to the conversation and consumed by a single
`take`, so a tool from another plugin — `hubspot:file`, say — can upload it
without the two plugins knowing each other and without the bytes passing through
the model.

## Development

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
npm test
npm run typecheck
```

The tests cover input validation and template rendering, which need no browser.
