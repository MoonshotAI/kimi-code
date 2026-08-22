// packages/app-core/src/lib/placeholderHtml.ts
// The composer placeholder can carry a CONTROLLED subset of HTML in its i18n
// copy — today only <kbd>…</kbd>, so keyboard shortcuts render as keycaps
// instead of plain "Ctrl+S" text. The copy is our own (not user input), but
// the renderer still whitelists rather than passing raw HTML through:
// `placeholderHtml` escapes everything except exact <kbd>…</kbd> pairs, so a
// malformed translation degrades to literal text, never to injected markup.
// Only its return value is safe to inject as HTML (the placeholder widget's
// innerHTML in app-composer's decoration layer).

import { escapeHtml } from './searchHighlight';

// Exact `<kbd>text</kbd>` pairs only — no attributes, no nesting. Anything
// fancier simply does not match and stays escaped (renders as literal text).
const KBD_PAIR = /<kbd>([\s\S]*?)<\/kbd>/g;

/**
 * Render a trusted placeholder string into safe HTML: all text is escaped,
 * while `<kbd>…</kbd>` pairs survive as keycap markup (their content is
 * escaped too). Any other tag stays escaped and shows as literal text.
 */
export function placeholderHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(KBD_PAIR)) {
    out += escapeHtml(text.slice(last, match.index));
    out += `<kbd>${escapeHtml(match[1] ?? '')}</kbd>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * The plain-text form of a placeholder string: `<kbd>` markers are stripped,
 * keeping the key label (`<kbd>Ctrl</kbd>+<kbd>S</kbd>` → `Ctrl+S`). For
 * consumers that cannot render HTML — the editor's aria-label.
 */
export function placeholderText(text: string): string {
  return text.replace(KBD_PAIR, '$1');
}
