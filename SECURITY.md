# Security Policy

## Supported Versions

Security fixes are applied to the `main` branch and to the latest tagged release. Older
releases are not maintained.

| Version     | Supported |
|-------------|-----------|
| `main`      | yes       |
| latest tag  | yes       |
| older tags  | no        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue to report a security vulnerability.**

Use GitHub's private vulnerability reporting instead:

1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability**.
3. Fill in the details (steps to reproduce, affected version, impact).

### What to expect

- We acknowledge reports within **48 hours**.
- We aim to triage and confirm within **7 days**.
- We target a fix within **30 days** for high-severity issues; lower-severity issues may take longer.
- We coordinate disclosure with you and generally prefer **90 days** between report and public disclosure.
- We credit reporters in the release notes unless you prefer to stay anonymous.

### Scope

In scope:

- SSRF or other request forgery through `extra:markdownToPdf` (logo, template and image URLs) or `extra:fileUpload`
- Script execution or local file access in the headless browser that renders PDFs
- Path traversal or key injection in the S3 object key built by `extra:fileUpload`
- Any way for an agent to reach S3 with an identity other than the static keys in its own secrets
- Exposure of agent secrets in logs, audit records or tool results

Out of scope:

- Attacks that require a malicious agent configuration: whoever configures an agent chooses its
  prompts, secrets and enabled tools by design
- Issues in third-party dependencies that do not affect this plugin's code paths (report those upstream)
- Deployment misconfiguration in the host engine

## Thanks

We appreciate the security community's efforts to keep Polyant safe. Thank you for reporting responsibly.
