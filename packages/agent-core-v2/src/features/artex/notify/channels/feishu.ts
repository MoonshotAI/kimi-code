import { createHmac } from 'node:crypto';

import { doHttpJson } from '../http';
import {
  MARKDOWN_RESERVED_BYTES,
  markdownBatchIntro,
  markdownText,
  markdownTitle,
} from '../markdown';
import { assetLine, truncateBytes } from '../render';
import { snippet, validateHttpUrl } from '../ssrf';
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

export const FEISHU_MAX_CARD_BYTES = 16_000;
export const FEISHU_ENVELOPE_BYTES = 113;

export function feishuSign(timestampSec: string, secret: string): string {
  const stringToSign = `${timestampSec}\n${secret}`;
  return createHmac('sha256', stringToSign).digest('base64');
}

export function feishuSeverityTemplate(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'high':
      return 'orange';
    case 'medium':
      return 'yellow';
    case 'low':
      return 'blue';
    default:
      return 'grey';
  }
}

function feishuJsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function feishuMarkdownDiv(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function feishuButton(label: string, url: string): Record<string, unknown> {
  return {
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'lark_md', content: label },
        url,
        type: 'primary',
      },
    ],
  };
}

function feishuItemLines(it: NotifyItem, limits: NotifyLimits): string {
  const title = notifyItemTitle(it);
  const lines = [`**${severityLabel(it.severity)} · ${markdownText(title, 0)}**`];
  if (isStatusChangeItem(it)) {
    lines.push(
      `**Status change**: ${markdownText(statusLabel(it.fromStatus ?? ''), 0)} → ${markdownText(statusLabel(it.toStatus ?? ''), 0)}`,
    );
  }
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
  return lines.join('\n');
}

function feishuBatchLine(it: NotifyItem, index: number, limits: NotifyLimits): string {
  let line = `**${String(index)}. ${severityLabel(it.severity)} · ${markdownText(notifyItemTitle(it), 0)}**`;
  const assets = assetLine(it.assets, limits.assetsShown);
  if (assets !== '') line += ` — ${markdownText(assets, 0)}`;
  return line;
}

export function feishuCard(message: NotifyMessage): {
  readonly card: Record<string, unknown>;
  readonly kept: number;
} {
  const limits = messageLimits(message);
  const budget = FEISHU_MAX_CARD_BYTES - MARKDOWN_RESERVED_BYTES;
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: markdownTitle(message) },
  };
  if (message.items[0] !== undefined) {
    header['template'] = feishuSeverityTemplate(message.items[0].severity);
  }
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header,
  };

  let elements: Record<string, unknown>[] = [];
  let kept = 0;

  if (message.batch) {
    const buildDigestElements = (
      n: number,
      lines: readonly Record<string, unknown>[],
    ): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [
        feishuMarkdownDiv(markdownBatchIntro(message, message.items.slice(0, n), message.items.length)),
        ...lines,
      ];
      if (message.homeUrl !== undefined && message.homeUrl !== '') {
        out.push(feishuButton('View all on the platform', message.homeUrl));
      }
      return out;
    };

    const lines: Record<string, unknown>[] = [];
    let used = 0;
    for (let i = 0; i < message.items.length; i += 1) {
      const line = feishuMarkdownDiv(
        truncateBytes(feishuBatchLine(message.items[i]!, i + 1, limits), budget),
      );
      used += feishuJsonSize(line) + 1;
      card['elements'] = buildDigestElements(i + 1, []);
      if (i > 0 && FEISHU_ENVELOPE_BYTES + feishuJsonSize(card) + used > FEISHU_MAX_CARD_BYTES) {
        break;
      }
      lines.push(line);
    }
    kept = lines.length;
    elements = buildDigestElements(kept, lines);
  } else if (message.items[0] !== undefined) {
    kept = 1;
    const it = message.items[0];
    elements.push(feishuMarkdownDiv(truncateBytes(feishuItemLines(it, limits), budget)));
    if (it.detailUrl !== undefined && it.detailUrl !== '') {
      elements.push(feishuButton('View details', it.detailUrl));
    }
  }

  card['elements'] = elements;
  return { card, kept };
}

export const feishuChannel: NotifyChannel = {
  kind: 'feishu',

  defaultRatePerMin(): number {
    return 100;
  },

  secretKeys(): readonly string[] {
    return ['webhook', 'secret'];
  },

  destinationKeys(): readonly string[] {
    return ['webhook'];
  },

  validate(cfg: Readonly<Record<string, unknown>>, options?: NotifyTransportOptions): void {
    const hook = cfgString(cfg, 'webhook');
    if (hook === '') {
      throw new Error('missing Webhook URL');
    }
    try {
      validateHttpUrl(hook, options);
    } catch (error) {
      throw new Error(
        `invalid webhook URL: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
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

    const { card, kept } = feishuCard(message);
    const payload: Record<string, unknown> = {
      msg_type: 'interactive',
      card,
    };
    const secret = cfgString(cfg, 'secret');
    if (secret !== '') {
      const nowMs = options?.nowMs ? options.nowMs() : Date.now();
      const ts = String(Math.floor(nowMs / 1000));
      payload['timestamp'] = ts;
      payload['sign'] = feishuSign(ts, secret);
    }

    const raw = await doHttpJson('POST', cfgString(cfg, 'webhook'), undefined, payload, options);
    let res: {
      code?: number;
      msg?: string;
      StatusCode?: number;
      StatusMessage?: string;
    };
    try {
      res = JSON.parse(raw.toString('utf8')) as typeof res;
    } catch (error) {
      throw new Error(
        `failed to parse Feishu response: ${error instanceof Error ? error.message : String(error)} (${snippet(raw)})`,
        { cause: error },
      );
    }
    if ((res.code ?? 0) !== 0) {
      throw permanentError(`Feishu returned error ${String(res.code ?? 0)}: ${res.msg ?? ''}`);
    }
    if ((res.StatusCode ?? 0) !== 0) {
      throw permanentError(
        `Feishu returned error ${String(res.StatusCode ?? 0)}: ${res.StatusMessage ?? ''}`,
      );
    }
    return kept;
  },
};
