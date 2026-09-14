// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Escape the five HTML-significant characters.
 *
 * One implementation, for every place this engine emits HTML someone's browser
 * will render: the transactional mail templates, the PDF template renderer and
 * the OAuth callback pages. Each had written its own — same five replacements,
 * two of them in a different ORDER, none of them tested — and the set of
 * characters that has to be escaped is exactly the kind of thing that gets
 * extended once (a backtick, a slash) and then extended in one copy.
 *
 * `&` MUST be replaced first, or the ampersand of a later entity gets escaped
 * again (`<` → `&lt;` → `&amp;lt;`). That ordering constraint is the reason this
 * is a shared function rather than a shared regex.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
