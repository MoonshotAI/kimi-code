
const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

export function highlightHtml(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const q = query.trim();
  if (q.length === 0) return escaped;
  const re = new RegExp(escapeRegExp(escapeHtml(q)), 'gi');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}
