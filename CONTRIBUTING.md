# Contributing to polyant-extra-plugin

Thank you for your interest in contributing. This repository is a plugin for the
[Polyant](https://github.com/polyant-ai/polyant) engine; this document covers what you need to
work on it.

## Prerequisites

- **Node.js 24+** (the engine image builds plugins on Node 24)
- npm

## Local Setup

```bash
git clone https://github.com/polyant-ai/polyant-extra-plugin.git
cd polyant-extra-plugin
PUPPETEER_SKIP_DOWNLOAD=true npm ci
```

`PUPPETEER_SKIP_DOWNLOAD` avoids fetching a Chromium build; the tests need no browser.

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run the unit tests |
| `npm run test:watch` | Run the tests in watch mode |
| `npm run typecheck` | TypeScript check |

## Development Workflow

For non-trivial changes, open an issue first to discuss the approach.

1. Fork the repository and create a branch from `main`.
2. Make your change. Tools are `*.tool.ts` files under `tools/` that default-export a
   `defineTool(...)` from `@polyant-ai/plugin-sdk`; shared helpers live in `lib/`.
3. Run the checks before pushing:
   ```bash
   npm run typecheck   # must pass with 0 errors
   npm test            # all tests must pass
   ```

### Code conventions

- Relative imports end in `.js`, as in the existing files.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Tool descriptions, error messages and comments are written in English.
- A tool's `parameters` is a static Zod schema; it must not read the tool context.
- Never hardcode secrets.

### Commit conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description
```

Valid types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`.

### Sign your work (DCO)

Contributions use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a Contributor License Agreement. Every commit must include a `Signed-off-by` line:

    git commit -s -m "feat: my change"

The `-s` flag uses your `git config user.name` and `user.email`. If you forgot to sign a
commit, amend it with:

    git commit --amend -s --no-edit

### Pull Request process

1. Open a PR against `main` with a title in Conventional Commits format.
2. Describe what changes, why, and how to test it.
3. CI must pass (typecheck and tests).
4. All commits must be signed off.
5. At least one maintainer review is required before merge.

## Reporting Security Issues

Please do not open a public GitHub issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[AGPL-3.0 License](LICENSE).
