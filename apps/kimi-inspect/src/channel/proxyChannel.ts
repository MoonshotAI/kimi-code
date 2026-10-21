import type { Event, IChannel } from './channel';
import { RPCError } from './errors';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
  readonly details?: unknown;
}

export interface ProxyChannelOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export class ProxyChannel implements IChannel {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProxyChannelOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  async call<T>(command: string, args: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (args.length > 0) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args);
    }
    if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/${command}`, {
      method: 'POST',
      headers,
      body,
    });
    const envelope = (await res.json()) as Envelope<T>;
    if (envelope.code !== 0) {
      throw new RPCError(envelope.code, envelope.msg, envelope.details);
    }
    return envelope.data;
  }

  listen<T>(_event: string): Event<T> {
    throw new Error(
      'events are not supported on this channel (HTTP-only; the /api/v2/ws event socket was removed)',
    );
  }
}
