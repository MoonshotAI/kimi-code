/**
 * HTTP channel — one `POST /api/v2/[scope/]service/method` per call with the
 * args tuple as the JSON body, unwrapping the server envelope. `listen` is
 * delegated to a lazily created WS event bridge, so the transport exposes
 * the full `KlientChannel` surface despite HTTP being request/response only.
 */

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import type { WsLikeCtor } from '../ws/wsSocket.js';
import { WsEventBridge } from './eventBridge.js';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
  readonly details?: unknown;
}

export interface HttpChannelOptions {
  /** Server base URL, e.g. `http://127.0.0.1:58627`. */
  readonly url: string;
  readonly token?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** WebSocket implementation for the lazy event bridge (Node ≥ 21 / browsers have one). */
  readonly WebSocketImpl?: WsLikeCtor;
}

function scopePath(scope: ScopeRef): string {
  let path = '';
  if (scope.sessionId !== undefined) {
    path += `/session/${encodeURIComponent(scope.sessionId)}`;
  }
  if (scope.agentId !== undefined) {
    path += `/agent/${encodeURIComponent(scope.agentId)}`;
  }
  return path;
}

export class HttpChannel implements KlientChannel {
  private readonly baseUrl: string;
  private readonly url: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl?: WsLikeCtor;
  private eventBridge: WsEventBridge | undefined;

  constructor(options: HttpChannelOptions) {
    this.url = options.url;
    this.baseUrl = `${options.url.replace(/\/$/, '')}/api/v2`;
    this.token = options.token;
    // Bind the global fetch: browsers throw "Illegal invocation" when the
    // native function is invoked with a non-Window receiver.
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.WebSocketImpl = options.WebSocketImpl;
  }

  async call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (args.length > 0) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args);
    }
    if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${scopePath(scope)}/${service}/${method}`, {
      method: 'POST',
      headers,
      body,
    });
    const envelope = (await res.json()) as Envelope<unknown>;
    if (envelope.code !== 0) {
      throw new RPCError(envelope.code, envelope.msg, envelope.details);
    }
    return envelope.data;
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    this.eventBridge ??= new WsEventBridge({
      url: this.url,
      token: this.token,
      WebSocketImpl: this.WebSocketImpl,
    });
    return this.eventBridge.listen(scope, source, handler, onError);
  }

  close(): Promise<void> {
    this.eventBridge?.close();
    this.eventBridge = undefined;
    return Promise.resolve();
  }
}
