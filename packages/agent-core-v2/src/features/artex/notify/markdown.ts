import { assetLine, byteSize, oneLine, packItemCount, truncateBytes } from './render';
import {
  isStatusChangeItem,
  messageLimits,
  notifyItemTitle,
  severityLabel,
  statusLabel,
  type NotifyItem,
  type NotifyLimits,
  type NotifyMessage,
} from './types';

export const MARKDOWN_RESERVED_BYTES = 320;

const MARKDOWN_ESCAPE_RE = /[\\`*_[\]()!#>|~]/g;

export function markdownEscape(s: string): string {
  return s.replaceAll(MARKDOWN_ESCAPE_RE, (ch) => `\\${ch}`);
}

export function markdownText(s: string, maxRunes: number): string {
  return markdownEscape(oneLine(s, maxRunes));
}

export function markdownTitle(m: NotifyMessage): string {
  if (m.batch) return `Vulnerability digest · ${String(m.items.length)} total`;
  const first = m.items[0];
  if (first === undefined) return 'Vulnerability notification';
  return `[${severityLabel(first.severity)}] ${oneLine(notifyItemTitle(first), 0)}`;
}

export function markdownBatchIntro(
  m: NotifyMessage,
  items: readonly NotifyItem[],
  total: number,
): string {
  let out =
    m.windowMinutes !== undefined && m.windowMinutes > 0
      ? `**${String(total)} new vulnerabilities in the last ${String(m.windowMinutes)} minutes**`
      : `**${String(total)} new vulnerabilities**`;

  const extra = total - items.length;
  if (extra > 0) {
    out += ` (this message shows the first ${String(items.length)}, the remaining ${String(extra)} will continue in the next message)`;
  }

  const counts: Record<string, number> = {};
  for (const it of items) {
    counts[it.severity] = (counts[it.severity] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const n = counts[sev] ?? 0;
    if (n > 0) parts.push(`${severityLabel(sev)} ${String(n)}`);
  }
  if (parts.length > 0) out += `\n${parts.join(' · ')}`;
  return `${out}\n\n`;
}

export function formatMarkdownItem(
  it: NotifyItem,
  prefix: string,
  single: boolean,
  limits: NotifyLimits,
): string {
  let line = `${prefix}**${severityLabel(it.severity)} · ${markdownText(notifyItemTitle(it), 0)}**`;
  if (!single) {
    const extras: string[] = [];
    const assets = assetLine(it.assets, limits.assetsShown);
    if (assets !== '') extras.push(markdownText(assets, 0));
    if (it.summary !== '') extras.push(markdownText(it.summary, 60));
    if (extras.length > 0) line += ` — ${extras.join(' · ')}`;
    return `${line}\n`;
  }

  const lines = [line];
  if (isStatusChangeItem(it)) {
    lines.push(
      `**Status change**: ${markdownText(statusLabel(it.fromStatus ?? ''), 0)} → ${markdownText(statusLabel(it.toStatus ?? ''), 0)}`,
    );
  }
  const title = notifyItemTitle(it);
  if (it.vulnclass !== '' && it.vulnclass !== title) {
    lines.push(`**Type**: ${markdownText(it.vulnclass, 0)}`);
  }
  const assets = assetLine(it.assets, limits.assetsShown);
  if (assets !== '') {
    lines.push(`**Assets**: ${markdownText(assets, 0)}`);
  }
  if (it.summary !== '') {
    const summary = markdownText(it.summary, limits.summaryRunes);
    if (summary !== '') lines.push(`**Summary**: ${summary}`);
  }
  if (it.detailUrl !== undefined && it.detailUrl !== '') {
    lines.push(`[View details](${it.detailUrl})`);
  }
  return `${lines.join('\n')}\n`;
}

export function markdownBody(
  m: NotifyMessage,
  maxBytes: number,
): { readonly body: string; readonly kept: number } {
  const limits = messageLimits(m);
  if (!m.batch) {
    const first = m.items[0];
    if (first === undefined) return { body: '', kept: 0 };
    return {
      body: truncateBytes(formatMarkdownItem(first, '', true, limits), maxBytes),
      kept: 1,
    };
  }

  const footer =
    m.homeUrl !== undefined && m.homeUrl !== ''
      ? `\n[View all on the platform](${m.homeUrl})\n`
      : '';

  const kept = packItemCount(
    m.items,
    maxBytes,
    MARKDOWN_RESERVED_BYTES,
    footer,
    byteSize,
    (it, idx) => formatMarkdownItem(it, `${String(idx + 1)}. `, false, limits),
  );

  const items = m.items.slice(0, kept);
  const parts = [markdownBatchIntro(m, items, m.items.length)];
  for (let i = 0; i < items.length; i += 1) {
    parts.push(formatMarkdownItem(items[i]!, `${String(i + 1)}. `, false, limits));
  }
  parts.push(footer);
  return {
    body: truncateBytes(parts.join(''), maxBytes),
    kept,
  };
}
