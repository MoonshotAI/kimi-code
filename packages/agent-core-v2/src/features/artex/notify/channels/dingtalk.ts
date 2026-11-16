import { createHmac } from 'node:crypto';

import { doHttpJson } from '../http';
import { markdownBody, markdownTitle } from '../markdown';
import { redactRequestTarget, snippet, validateHttpUrl } from '../ssrf';
import {
  cfgString,
  permanentError,
  type NotifyChannel,
  type NotifyMessage,
  type NotifyTransportOptions,
} from '../types';

export const DINGTALK_MARKDOWN_MAX_BYTES = 20_000;

export function dingTalkSignedUrl(hook: string, secret: string, nowMs: number): string {
  if (secret === '') return hook;
  const ts = String(nowMs);
  const stringToSign = `${ts}\n${secret}`;
  const sign = createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');

  let parsed: URL;
  try {
    parsed = new URL(hook);
  } catch {
    throw new Error(`failed to parse Webhook address: ${redactRequestTarget(hook)}`);
  }
  parsed.searchParams.set('timestamp', ts);
  parsed.searchParams.set('sign', sign);
  return parsed.toString();
}

export const dingTalkChannel: NotifyChannel = {
  kind: 'dingtalk',

  defaultRatePerMin(): number {
    return 20;
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
      throw new Error('missing Webhook address');
    }
    try {
      validateHttpUrl(hook, options);
    } catch (error) {
      throw new Error(
        `invalid Webhook address: ${error instanceof Error ? error.message : String(error)}`,
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

    const hook = cfgString(cfg, 'webhook');
    const secret = cfgString(cfg, 'secret');
    const nowMs = options?.nowMs ? options.nowMs() : Date.now();
    let endpoint: string;
    try {
      endpoint = dingTalkSignedUrl(hook, secret, nowMs);
    } catch (error) {
      throw permanentError(error);
    }

    const title = markdownTitle(message);
    const { body: text, kept } = markdownBody(message, DINGTALK_MARKDOWN_MAX_BYTES);

    const first = message.items[0];
    const payload =
      !message.batch &&
      message.items.length === 1 &&
      first !== undefined &&
      first.detailUrl !== undefined &&
      first.detailUrl !== ''
        ? {
            msgtype: 'actionCard',
            actionCard: {
              title,
              text,
              btnOrientation: '0',
              singleTitle: 'View details',
              singleURL: first.detailUrl,
            },
          }
        : {
            msgtype: 'markdown',
            markdown: { title, text },
          };

    const raw = await doHttpJson('POST', endpoint, undefined, payload, options);
    let res: { errcode?: number; errmsg?: string };
    try {
      res = JSON.parse(raw.toString('utf8')) as { errcode?: number; errmsg?: string };
    } catch (error) {
      throw new Error(
        `failed to parse DingTalk response: ${error instanceof Error ? error.message : String(error)} (${snippet(raw)})`,
        { cause: error },
      );
    }
    if ((res.errcode ?? 0) !== 0) {
      throw permanentError(
        `DingTalk returned error ${String(res.errcode ?? 0)}: ${res.errmsg ?? ''}`,
      );
    }
    return kept;
  },
};
