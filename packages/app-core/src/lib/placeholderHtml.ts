
import { escapeHtml } from './searchHighlight';

const KBD_PAIR = /<kbd>([\s\S]*?)<\/kbd>/g;

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

export function placeholderText(text: string): string {
  return text.replace(KBD_PAIR, '$1');
}
