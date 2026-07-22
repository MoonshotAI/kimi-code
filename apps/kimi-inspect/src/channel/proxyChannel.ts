/**
 * `ProxyChannel` — an `IChannel` bound to one Service, routing `call`s to
 * kap-server's `/api/v1/debug` HTTP surface. Every call `POST`s the method
 * name to the Service base URL with the complete argument array as the JSON
 * body, then unwraps the project envelope: a non-zero `code` throws
 * `RPCError`, otherwise `data` is returned. Non-function members answer as
 * property reads through the same route (the dispatcher returns them as-is).
 *
 * `listen` cannot be served by HTTP: the v2 event socket (`/api/v2/ws`) that
 * used to back Service emitter events was removed, so `listen` throws and
 * the UI fetches Service state on demand instead.
 */

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
  /** Service base URL, e.g. `http://127.0.0.1:58627/api/v1/debug[/session/:sid[/agent/:aid]]/:service`. */
  readonly baseUrl: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export class ProxyChannel implements IChannel {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProxyChannelOptions) {
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

  listen<T>(_event: string): Event<T> {
    throw new Error(
      'events are not supported on this channel (HTTP-only; the /api/v2/ws event socket was removed)',
    );
  }
}
