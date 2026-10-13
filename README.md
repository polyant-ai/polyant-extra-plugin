# polyant-extra-plugin

Optional tools for the [Polyant](https://github.com/polyant-ai/polyant) engine that not every
deployment needs, kept out of the engine image so nothing pays for them by default.

The plugin namespace is `extra`, so the engine registers each tool as `extra:<name>`.

## Tools

| Tool | What it does |
| --- | --- |
| `extra:markdownToPdf` | Renders Markdown to an A4 PDF (default style, a branded `enterprise` style with cover page and pagination, or a caller-supplied Marp+Mustache template) and returns a `fileHandle` to the bytes |
| `extra:fileUpload` | Uploads a message attachment or base64 data (max 10 MB) to the agent's S3 bucket and returns its key and URL |

`extra:markdownToPdf` returns a handle, not the PDF itself. The bytes stay in the engine's
artifact store, bound to the conversation and consumed by a single read, so another tool such as
`extra:fileUpload` can pick the file up without the bytes passing through the model.

## Requirements

- Polyant engine `>= 1.3.0` (declared in `plugin.json`)
- Plugin SDK `v1.9.0` (`@polyant-ai/plugin-sdk`, pinned in `package.json`)
- An Alpine-based engine image built from source. `markdownToPdf` needs Chromium, which the
  plugin declares in `plugin.json` (`system.apk` and `system.env`); the engine's
  `Dockerfile.engine` installs it at build time.

## Secrets and settings

`extra:fileUpload` reads four secrets from the agent, all required:

| Secret | Meaning |
| --- | --- |
| `s3_bucket_name` | Bucket the files are uploaded to |
| `aws_region` | Region of the bucket, for example `eu-west-1` |
| `aws_access_key_id` | Access key of an IAM identity allowed to write to the bucket |
| `aws_secret_access_key` | Secret of that access key |

The S3 client always uses these static keys. There is no task-role mode and no fallback to the
AWS default credential chain, so an agent can never act with the deployment's own identity. When
a key is missing the tool returns `not_configured` and sends nothing. Files are stored under
`{instanceId}/{conversationId}/{filename}`, and the latest upload is kept in conversation state
as `lastUploadedFile`.

`extra:markdownToPdf` needs no secrets. One optional environment variable on the engine process
sets its concurrency:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PDF_CONCURRENCY` | `3` | Maximum parallel renders (1 to 32). Each render holds a Chromium page of roughly 50-100 MB, so this is a memory bound |

## Add it to an engine built from source

The engine picks plugins up at image build time. In the `plugins` stage of `Dockerfile.engine`
it reads every directory under `packages/engine/src/plugins/` that contains a `plugin.json`,
runs `npm install` there, compiles the TypeScript in place, collects the `system` blocks
(packages and environment variables) into the runtime image, and copies the result to
`dist/plugins/<name>`, where the loader scans it at boot. See
[docs/plugins.md](https://github.com/polyant-ai/polyant/blob/develop/docs/plugins.md) in the
engine repository for the full contract.

From the root of your checkout of the Polyant engine, clone this repository at a release tag
into that directory, then build the image:

```bash
git clone --depth 1 --branch v1.1.0 \
  https://github.com/polyant-ai/polyant-extra-plugin.git \
  packages/engine/src/plugins/extra
docker build -f Dockerfile.engine -t polyant-engine .
```

Use a real directory, not a symlink. The plugin installs its own `node_modules` during the
build, over https, because the plugin SDK is a public git dependency.

Once the engine is running, enable `extra:markdownToPdf` and `extra:fileUpload` for each agent
that should use them, and set the S3 secrets above for agents that upload files.

The plugin is also installable from the Polyant marketplace for Polyant Enterprise.

## Development

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm test
npm run typecheck
```

The tests cover input validation and template rendering, which need no browser. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
