import { markdownTitle } from './markdown';
import { assetLine, oneLine, truncateHtml } from './render';
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

export function htmlSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '#d32029';
    case 'high':
      return '#e8830c';
    case 'medium':
      return '#d4b106';
    case 'low':
      return '#1677ff';
    default:
      return '#8c8c8c';
  }
}

export function htmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function htmlEscapeAttr(s: string): string {
  return htmlEscape(s).replaceAll('"', '&quot;');
}

export function htmlTitle(m: NotifyMessage): string {
  return markdownTitle(m);
}

function htmlBatchIntro(m: NotifyMessage): string {
  const heading =
    m.windowMinutes !== undefined && m.windowMinutes > 0
      ? `<h2 style="font-size:16px;margin:0 0 4px;">${String(m.items.length)} new vulnerabilities in the last ${String(m.windowMinutes)} minutes</h2>`
      : `<h2 style="font-size:16px;margin:0 0 4px;">${String(m.items.length)} new vulnerabilities</h2>`;

  const counts: Record<string, number> = {};
  for (const it of m.items) {
    counts[it.severity] = (counts[it.severity] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const n = counts[sev] ?? 0;
    if (n > 0) {
      parts.push(
        `<span style="color:${htmlSeverityColor(sev)};font-weight:600;">${htmlEscape(severityLabel(sev))} ${String(n)}</span>`,
      );
    }
  }
  if (parts.length === 0) return heading;
  return `${heading}<p style="margin:0 0 12px;">${parts.join(' &middot; ')}</p>`;
}

function htmlItem(it: NotifyItem, full: boolean, limits: NotifyLimits): string {
  const color = htmlSeverityColor(it.severity);
  const border = full
    ? `<div style="border-left:4px solid ${color};padding:8px 0 8px 12px;margin-bottom:12px;">`
    : `<div style="border-left:3px solid ${color};padding:4px 0 4px 10px;margin-bottom:8px;">`;
  const title = notifyItemTitle(it);
  const header = `<div style="font-weight:600;">${htmlEscape(severityLabel(it.severity))} &middot; ${htmlEscape(title)}</div>`;

  if (!full) {
    const extras: string[] = [];
    const assets = assetLine(it.assets, limits.assetsShown);
    if (assets !== '') extras.push(htmlEscape(assets));
    if (it.summary !== '') extras.push(htmlEscape(oneLine(it.summary, 60)));
    const extraHtml =
      extras.length > 0
        ? `<div style="color:#595959;font-size:13px;">${extras.join(' &middot; ')}</div>`
        : '';
    return `${border}${header}${extraHtml}</div>`;
  }

  const bodyParts: string[] = [border, header];
  if (isStatusChangeItem(it)) {
    bodyParts.push(
      `<div><b>Status change</b>: ${htmlEscape(statusLabel(it.fromStatus ?? ''))} → ${htmlEscape(statusLabel(it.toStatus ?? ''))}</div>`,
    );
  }
  if (it.vulnclass !== '' && it.vulnclass !== title) {
    bodyParts.push(`<div><b>Type</b>: ${htmlEscape(it.vulnclass)}</div>`);
  }
  const assets = assetLine(it.assets, limits.assetsShown);
  if (assets !== '') {
    bodyParts.push(`<div><b>Assets</b>: ${htmlEscape(assets)}</div>`);
  }
  const summary = oneLine(it.summary, limits.summaryRunes);
  if (summary !== '') {
    bodyParts.push(`<div><b>Summary</b>: ${htmlEscape(summary)}</div>`);
  }
  if (it.detailUrl !== undefined && it.detailUrl !== '') {
    bodyParts.push(
      `<div style="margin-top:6px;"><a href="${htmlEscapeAttr(it.detailUrl)}" style="color:#1677ff;">View details</a></div>`,
    );
  }
  bodyParts.push('</div>');
  return bodyParts.join('');
}

export function htmlBody(m: NotifyMessage, maxRunes: number): string {
  const limits = messageLimits(m);
  const parts: string[] = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;color:#262626;line-height:1.6;">`,
  ];
  if (m.batch) {
    parts.push(htmlBatchIntro(m));
    for (const it of m.items) {
      parts.push(htmlItem(it, false, limits));
    }
  } else if (m.items[0] !== undefined) {
    parts.push(htmlItem(m.items[0], true, limits));
  }
  if (m.homeUrl !== undefined && m.homeUrl !== '') {
    parts.push(
      `<p style="margin:16px 0 0;"><a href="${htmlEscapeAttr(m.homeUrl)}" style="color:#1677ff;">View all on the platform</a></p>`,
    );
  }
  parts.push('</div>');
  return truncateHtml(parts.join(''), maxRunes);
}
