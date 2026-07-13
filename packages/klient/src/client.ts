/**
 * `/api/v2` client — three-level scope entry (core / session / agent) over the
 * HTTP channel.
 *
 *   const client = new Klient({ url: 'http://127.0.0.1:58627' });
 *   await client.core(ISessionIndex).list({});
 *   await client.session('s1').service(ISessionMetadata).read();
 *   await client.session('s1').agent('a1').service(IAgentProfile).getModel();
 *
 * The `agent-core-v2` service token is the whole key: its type parameter `T`
 * types the returned proxy, and its decorator id (`String(id)`) is the channel
 * name in the URL. Each scope level binds a channel to
 * `<scope-url>/<decorator-id>` and hands back a typed proxy via `makeProxy`,
 * which forwards method calls verbatim to the server's reflection dispatcher.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import type { IChannel } from './channel.js';
import { HttpChannel, type HttpChannelOptions } from './httpChannel.js';
import { makeProxy } from './proxy.js';
import { WsKlient } from './wsKlient.js';
import type { WsLikeCtor } from './wsSocket.js';

export interface KlientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly url: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** WebSocket implementation for `ws()`; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
}

export class Klient {
  private readonly url: string;
  private readonly token?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly wsImpl?: WsLikeCtor;
  private wsKlient?: WsKlient;

  constructor(opts: KlientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
    this.wsImpl = opts.WebSocketImpl;
  }

  private channelOptions(baseUrl: string): HttpChannelOptions {
    return { baseUrl, token: this.token, fetch: this.fetchImpl };
  }

  /** Core-scoped Service, e.g. `client.core(ISessionIndex)`. */
  core<T extends object>(id: ServiceIdentifier<T>): T {
    return makeProxy<T>(
      new HttpChannel(this.channelOptions(`${this.url}/api/v2/${String(id)}`)),
    );
  }

  /** Session scope entry point. */
  session(sessionId: string): SessionClient {
    return new SessionClient(this.url, this.token, this.fetchImpl, sessionId);
  }

  /**
   * WebSocket counterpart of this client — same scopes and typed proxies over
   * the persistent `/api/v2/ws` socket, plus event `listen`s. Lazily created
   * on first call so one `Klient` holds at most one live socket; close it with
   * `client.ws().close()`. After a close, the next `ws()` call lazily creates a
   * fresh `WsKlient` (so React StrictMode's mount → unmount → mount cycle,
   * whose cleanup closes the socket, recovers on the second mount).
   */
  ws(): WsKlient {
    if (this.wsKlient === undefined || this.wsKlient.state === 'closed') {
      this.wsKlient = new WsKlient({
        url: this.url,
        token: this.token,
        WebSocketImpl: this.wsImpl,
      });
    }
    return this.wsKlient;
  }
}

export class SessionClient {
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch | undefined,
    sessionId: string,
  ) {
    this.baseUrl = `${url.replace(/\/$/, '')}/api/v2/session/${encodeURIComponent(sessionId)}`;
  }

  /** Session-scoped Service, e.g. `.service(ISessionMetadata)`. */
  service<T extends object>(id: ServiceIdentifier<T>): T {
    const channel: IChannel = new HttpChannel({
      baseUrl: `${this.baseUrl}/${String(id)}`,
      token: this.token,
      fetch: this.fetchImpl,
    });
    return makeProxy<T>(channel);
  }

  /** Agent scope entry point. */
  agent(agentId: string): AgentClient {
    return new AgentClient(this.baseUrl, this.token, this.fetchImpl, agentId);
  }
}

export class AgentClient {
  private readonly baseUrl: string;

  constructor(
    sessionBaseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch | undefined,
    agentId: string,
  ) {
    this.baseUrl = `${sessionBaseUrl}/agent/${encodeURIComponent(agentId)}`;
  }

  /** Agent-scoped Service, e.g. `.service(IAgentProfile)`. */
  service<T extends object>(id: ServiceIdentifier<T>): T {
    const channel: IChannel = new HttpChannel({
      baseUrl: `${this.baseUrl}/${String(id)}`,
      token: this.token,
      fetch: this.fetchImpl,
    });
    return makeProxy<T>(channel);
  }
}
