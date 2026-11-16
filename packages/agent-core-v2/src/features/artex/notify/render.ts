import type { NotifyItem } from './types';

export const ELLIPSIS = '…';

export function truncateBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return s;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const ellipsisLen = Buffer.byteLength(ELLIPSIS, 'utf8');
  let budget = maxBytes - ellipsisLen;
  let suffix = ELLIPSIS;
  if (budget < 0) {
    budget = maxBytes;
    suffix = '';
  }
  let cut = budget;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buf.subarray(0, cut).toString('utf8') + suffix;
}

export function truncateRunes(s: string, maxRunes: number): string {
  if (maxRunes <= 0) return s;
  const runes = Array.from(s);
  if (runes.length <= maxRunes) return s;
  if (maxRunes <= 1) return runes.slice(0, maxRunes).join('');
  return runes.slice(0, maxRunes - 1).join('') + ELLIPSIS;
}

export function oneLine(s: string, maxRunes: number): string {
  const collapsed = s.trim().split(/\s+/).filter((p) => p.length > 0).join(' ');
  return truncateRunes(collapsed, maxRunes);
}

export function truncateHtml(s: string, maxRunes: number): string {
  if (maxRunes <= 0 || Array.from(s).length <= maxRunes) return s;
  let cut = truncateRunes(s, maxRunes);
  const lt = cut.lastIndexOf('<');
  if (lt >= 0 && !cut.slice(lt).includes('>')) {
    cut = cut.slice(0, lt);
  }
  const amp = cut.lastIndexOf('&');
  if (amp >= 0 && !cut.slice(amp).includes(';')) {
    cut = cut.slice(0, amp);
  }
  return cut;
}

export function byteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function runeSize(s: string): number {
  return Array.from(s).length;
}

export function packItemCount(
  items: readonly NotifyItem[],
  maxSize: number,
  reserve: number,
  footer: string,
  size: (s: string) => number,
  render: (item: NotifyItem, index: number) => string,
): number {
  if (maxSize <= 0) return items.length;
  const budget = Math.max(0, maxSize - reserve - size(footer));
  let used = 0;
  for (let i = 0; i < items.length; i += 1) {
    used += size(render(items[i]!, i));
    if (used > budget && i > 0) return i;
  }
  return items.length;
}

export function assetLine(assets: readonly string[], limit: number): string {
  if (assets.length === 0) return '';
  if (limit <= 0 || assets.length <= limit) return assets.join(', ');
  return `${assets.slice(0, limit).join(', ')} and ${String(assets.length - limit)} more`;
}
