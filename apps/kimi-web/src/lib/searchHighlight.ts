// apps/kimi-web/src/lib/searchHighlight.ts
// Pure helpers for the session search dialog: extract a snippet around the
// matched query and render it with <mark> highlights. Kept framework-agnostic
// so it can be unit-tested without mounting a component.
//
// Security: `highlightHtml` escapes the source text BEFORE injecting <mark>,
// and the query is regexp-escaped before use — so a query like `<script>` or
// `.*` never produces executable markup or throws. Only its return value is
// safe to render with `v-html`; never v-html raw user input.

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape the five HTML-significant characters. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

/** Escape regexp metacharacters so `s` matches literally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a short window of `text` around the first case-insensitive match of
 * `query`, adding leading/trailing ellipses when the window is clipped. When
 * the query is empty or not found, returns the head of `text`. Newlines are
 * collapsed to spaces so the snippet renders on a single line.
 */
export function snippet(text: string, query: string, radius = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const q = query.trim();
  if (q.length === 0) return head(flat, radius * 2);

  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return head(flat, radius * 2);

  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + q.length + radius);
  const lead = start > 0;
  const tail = end < flat.length;
  return `${lead ? '…' : ''}${flat.slice(start, end)}${tail ? '…' : ''}`;
}

function head(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Return an HTML string of `text` with every case-insensitive occurrence of
 * `query` wrapped in `<mark>`. The source is HTML-escaped first and the query
 * is regexp-escaped, so the result is safe for `v-html`. An empty query returns
 * the escaped text unchanged.
 */
export function highlightHtml(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const q = query.trim();
  if (q.length === 0) return escaped;
  const re = new RegExp(escapeRegExp(escapeHtml(q)), 'gi');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}
