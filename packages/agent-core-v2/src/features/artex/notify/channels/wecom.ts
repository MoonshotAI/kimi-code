import { doHttpJson } from '../http';
import { markdownBody } from '../markdown';
import { snippet, validateHttpUrl } from '../ssrf';
import {
  cfgString,
  permanentError,
  type NotifyChannel,
  type NotifyMessage,
  type NotifyTransportOptions,
} from '../types';

export const WECOM_MARKDOWN_LIMIT = 4096;

export const weComChannel: NotifyChannel = {
  kind: 'wecom',

  defaultRatePerMin(): number {
    return 20;
  },

  secretKeys(): readonly string[] {
    return ['webhook'];
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

    const { body: content, kept } = markdownBody(message, WECOM_MARKDOWN_LIMIT);
    const payload = {
      msgtype: 'markdown',
      markdown: { content },
    };

    const raw = await doHttpJson('POST', cfgString(cfg, 'webhook'), undefined, payload, options);
    let res: { errcode?: number; errmsg?: string };
    try {
      res = JSON.parse(raw.toString('utf8')) as { errcode?: number; errmsg?: string };
    } catch (error) {
      throw new Error(
        `failed to parse WeCom response: ${error instanceof Error ? error.message : String(error)} (${snippet(raw)})`,
        { cause: error },
      );
    }
    const errcode = res.errcode ?? 0;
    if (errcode !== 0) {
      if (errcode === 45009) {
        throw new Error(`WeCom rate limited ${String(errcode)}: ${res.errmsg ?? ''}`);
      }
      throw permanentError(`WeCom returned error ${String(errcode)}: ${res.errmsg ?? ''}`);
    }
    return kept;
  },
};
