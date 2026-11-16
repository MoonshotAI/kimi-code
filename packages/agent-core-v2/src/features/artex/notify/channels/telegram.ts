import { doHttpJson } from '../http';
import { markdownTitle } from '../markdown';
import { assetLine, oneLine, packItemCount, runeSize, truncateHtml } from '../render';
import { redactRequestTarget, snippet, validateHttpUrl } from '../ssrf';
import {
  cfgString,
  isStatusChangeItem,
  messageLimits,
  notifyItemTitle,
  permanentError,
  severityLabel,
  statusLabel,
  type NotifyChannel,
  type NotifyItem,
  type NotifyLimits,
  type NotifyMessage,
  type NotifyTransportOptions,
} from '../types';

export const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_RESERVED_RUNES = 160;

export function telegramEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function telegramEscapeAttr(s: string): string {
  return telegramEscape(s).replaceAll('"', '&quot;');
}

function telegramBatchLine(it: NotifyItem, index: number, limits: NotifyLimits): string {
  const assets = assetLine(it.assets, limits.assetsShown);
  const title = notifyItemTitle(it);
  if (assets !== '') {
    return `${String(index)}. ${severityLabel(it.severity)} · ${title} — ${assets}`;
  }
  return `${String(index)}. ${severityLabel(it.severity)} · ${title}`;
}

function telegramBatchTitle(
  m: NotifyMessage,
  items: readonly NotifyItem[],
  total: number,
): string {
  let title = `Vulnerability digest · ${String(total)} total`;
  const extra = total - items.length;
  if (extra > 0) {
    title += ` (showing the first ${String(items.length)}, ${String(extra)} more in the next message)`;
  }
  if (m.windowMinutes !== undefined && m.windowMinutes > 0) {
    title = `Last ${String(m.windowMinutes)} min · ${title}`;
  }
  return title;
}

export function telegramHtml(message: NotifyMessage): {
  readonly html: string;
  readonly kept: number;
} {
  const limits = messageLimits(message);
  if (message.batch) {
    const footer =
      message.homeUrl !== undefined && message.homeUrl !== ''
        ? `\n\n<a href="${telegramEscapeAttr(message.homeUrl)}">View all on the platform</a>`
        : '';
    const kept = packItemCount(
      message.items,
      TELEGRAM_TEXT_LIMIT,
      TELEGRAM_RESERVED_RUNES,
      footer,
      runeSize,
      (it, idx) => telegramBatchLine(it, idx + 1, limits),
    );
    const items = message.items.slice(0, kept);
    const parts = [`<b>${telegramEscape(telegramBatchTitle(message, items, message.items.length))}</b>`];
    for (let i = 0; i < items.length; i += 1) {
      parts.push(`\n${telegramEscape(telegramBatchLine(items[i]!, i + 1, limits))}`);
    }
    parts.push(footer);
    return {
      html: truncateHtml(parts.join(''), TELEGRAM_TEXT_LIMIT),
      kept,
    };
  }

  const first = message.items[0];
  if (first === undefined) {
    return { html: `<b>${telegramEscape(markdownTitle(message))}</b>\n`, kept: 0 };
  }

  const parts = [`<b>${telegramEscape(markdownTitle(message))}</b>\n`];
  if (isStatusChangeItem(first)) {
    parts.push(
      `\n<b>Status change</b>: ${telegramEscape(statusLabel(first.fromStatus ?? ''))} → ${telegramEscape(statusLabel(first.toStatus ?? ''))}`,
    );
  }
  const title = notifyItemTitle(first);
  if (first.vulnclass !== '' && first.vulnclass !== title) {
    parts.push(`\n<b>Type</b>: ${telegramEscape(first.vulnclass)}`);
  }
  const assets = assetLine(first.assets, limits.assetsShown);
  if (assets !== '') {
    parts.push(`\n<b>Assets</b>: ${telegramEscape(assets)}`);
  }
  const summary = oneLine(first.summary, limits.summaryRunes);
  if (summary !== '') {
    parts.push(`\n<b>Summary</b>: ${telegramEscape(summary)}`);
  }
  if (first.detailUrl !== undefined && first.detailUrl !== '') {
    parts.push(`\n\n<a href="${telegramEscapeAttr(first.detailUrl)}">View details</a>`);
  }
  return {
    html: truncateHtml(parts.join(''), TELEGRAM_TEXT_LIMIT),
    kept: 1,
  };
}

export function telegramEndpoint(cfg: Readonly<Record<string, unknown>>): string {
  let base = cfgString(cfg, 'base_url');
  if (base === '') base = 'https://api.telegram.org';
  base = base.replace(/\/+$/, '');
  const token = cfgString(cfg, 'bot_token');
  const raw = `${base}/bot${token}/sendMessage`;
  try {
    return new URL(raw).toString();
  } catch {
    throw new Error(`failed to build API URL (base URL: ${redactRequestTarget(base)})`);
  }
}

export const telegramChannel: NotifyChannel = {
  kind: 'telegram',

  defaultRatePerMin(): number {
    return 20;
  },

  secretKeys(): readonly string[] {
    return ['bot_token'];
  },

  destinationKeys(): readonly string[] {
    return ['base_url'];
  },

  validate(cfg: Readonly<Record<string, unknown>>, options?: NotifyTransportOptions): void {
    if (cfgString(cfg, 'bot_token') === '') {
      throw new Error('missing Bot Token');
    }
    if (cfgString(cfg, 'chat_id') === '') {
      throw new Error('missing Chat ID');
    }
    const base = cfgString(cfg, 'base_url');
    if (base !== '') {
      try {
        validateHttpUrl(base, options);
      } catch (error) {
        throw new Error(
          `invalid API URL: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  },

  async send(
    cfg: Readonly<Record<string, unknown>>,
    message: NotifyMessage,
    options?: NotifyTransportOptions,
  ): Promise<number> {
    try {
      this.validate(cfg, options);
    } catch (error) {
      throw permanentError(error);
    }

    let endpoint: string;
    try {
      endpoint = telegramEndpoint(cfg);
    } catch (error) {
      throw permanentError(error);
    }

    const { html: text, kept } = telegramHtml(message);
    const payload = {
      chat_id: cfgString(cfg, 'chat_id'),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };

    const raw = await doHttpJson('POST', endpoint, undefined, payload, options);
    let res: { ok?: boolean; error_code?: number; description?: string };
    try {
      res = JSON.parse(raw.toString('utf8')) as typeof res;
    } catch (error) {
      throw new Error(
        `failed to parse Telegram response: ${error instanceof Error ? error.message : String(error)} (${snippet(raw)})`,
        { cause: error },
      );
    }
    if (res.ok === true) {
      return kept;
    }
    if (res.error_code === 429) {
      throw new Error(`Telegram rate limit: ${res.description ?? ''}`);
    }
    throw permanentError(
      `Telegram returned error ${String(res.error_code ?? 0)}: ${res.description ?? ''}`,
    );
  },
};
