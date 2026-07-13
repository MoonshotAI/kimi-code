/**
 * `fetch`-backed `IChannel` for the `/api/v2` HTTP surface.
 *
 * Every call `POST`s the `resource:action` command to the scope base URL with
 * the single argument as a JSON body, then unwraps the project envelope: a
 * non-zero `code` throws `RPCError`, otherwise `data` is returned. The
 * server accepts `GET` for readonly actions too, but the client does not need
 * it. `fetch` is injectable so tests and non-global runtimes can supply it.
 */

import type { IChannel } from './channel.js';
import { RPCError } from './errors.js';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
  readonly details?: unknown;
}

export interface HttpChannelOptions {
  /** Scope base URL, e.g. `http://127.0.0.1:58627/api/v2[/session/:sid]`. */
  readonly baseUrl: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export class HttpChannel implements IChannel {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpChannelOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    // Bind the global fetch: browsers throw "Illegal invocation" when the
    // native function is invoked with a non-Window receiver.
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

  listen<T>(_event: string, _arg?: unknown): import('./channel.js').Event<T> {
    throw new Error('events are not supported over the HTTP channel; use the WS transport');
  }
}
