/**
 * `ServerClient` — the lark-style client SDK for `server-v2` (`/api/v2`).
 *
 * Resource tree mirrors the server's `actionMap`:
 *   sdk.sessions.list({ page_size: 20 })               // core
 *   sdk.workspaces.createOrTouch('/path')              // core
 *   sdk.session(sid).setTitle('renamed')               // session (flattened)
 *   sdk.session(sid).approvals.decide(aid, body)       // session resource
 *   sdk.session(sid).agent('main').prompts.submit({…}) // agent resource
 *
 * RPC runs over HTTP (`POST <resource>:<action>`); events run over a single
 * `/api/v2/ws` socket opened by `connect()`. The legacy `/api/v1` REST surface
 * is still reachable via `sdk.v1` (the unchanged v1 `HttpClient`).
 */
import { HttpClient } from '../http.js';

import { createCoreResources, type CoreResources } from './resources/core.js';
import { EventsClient } from './resources/events.js';
import { SessionScope } from './resources/session.js';
import { HttpRpc, type ScopeKind, type ScopeParams } from './transport/http.js';
import {
  type AnyMethod,
  type DynamicResource,
  makeDynamicResource,
} from './transport/rpcProxy.js';
import { V2Socket, type V2SocketOptions } from './transport/ws.js';

export interface ServerClientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Default `/api/v2`. */
  readonly apiPrefix?: string;
  /** Optional bearer token (sent on HTTP + WS upgrade). */
  readonly token?: string;
  /** Override `fetch` (testing). */
  readonly fetchImpl?: typeof fetch;
  /** Override the WebSocket implementation (testing / browser). */
  readonly wsImpl?: V2SocketOptions['wsImpl'];
  /** Default 30s. Per-RPC-call deadline on the WS transport. */
  readonly callTimeoutMs?: number;
  /** Directory for v1 report capture (passed through to the v1 `HttpClient`). */
  readonly reportDir?: string;
}

export class ServerClient implements CoreResources {
  readonly baseUrl: string;
  readonly apiPrefix: string;

  /** Legacy `/api/v1` REST client (unchanged). */
  readonly v1: HttpClient;

  readonly sessions: CoreResources['sessions'];
  readonly workspaces: CoreResources['workspaces'];
  readonly config: CoreResources['config'];
  readonly providers: CoreResources['providers'];
  readonly oauth: CoreResources['oauth'];
  readonly auth: CoreResources['auth'];
  readonly flags: CoreResources['flags'];
  readonly plugins: CoreResources['plugins'];
  readonly fs: CoreResources['fs'];
  readonly meta: CoreResources['meta'];

  private readonly rpc: HttpRpc;
  private readonly token: string | undefined;
  private readonly wsImpl: ServerClientOptions['wsImpl'];
  private readonly callTimeoutMs: number | undefined;

  private socket: V2Socket | null = null;
  private eventsClient: EventsClient | null = null;

  constructor(opts: ServerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiPrefix = opts.apiPrefix ?? '/api/v2';
    this.token = opts.token;
    this.wsImpl = opts.wsImpl;
    this.callTimeoutMs = opts.callTimeoutMs;

    this.rpc = new HttpRpc({
      baseUrl: this.baseUrl,
      apiPrefix: this.apiPrefix,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
    });

    const core = createCoreResources(this.rpc);
    this.sessions = core.sessions;
    this.workspaces = core.workspaces;
    this.config = core.config;
    this.providers = core.providers;
    this.oauth = core.oauth;
    this.auth = core.auth;
    this.flags = core.flags;
    this.plugins = core.plugins;
    this.fs = core.fs;
    this.meta = core.meta;

    this.v1 = new HttpClient({
      baseUrl: this.baseUrl,
      apiPrefix: '/api/v1',
      fetchImpl: opts.fetchImpl ?? fetch,
      reportDir: opts.reportDir,
      token: opts.token,
    });
  }

  /** Enter the session scope for `sessionId`. */
  session(sessionId: string): SessionScope {
    return new SessionScope(this.rpc, sessionId);
  }

  /** Escape hatch for a core resource not (yet) in the manifest. */
  core<T extends Record<string, AnyMethod> = DynamicResource>(resource: string): T {
    return makeDynamicResource(this.rpc, 'core', {}, resource) as T;
  }

  /** Raw RPC — call any `<resource>:<action>` in any scope. */
  call<T>(scope: ScopeKind, params: ScopeParams, sa: string, arg?: unknown): Promise<T> {
    return this.rpc.call<T>(scope, params, sa, arg);
  }

  /** Open the `/api/v2/ws` socket and return the events client. Idempotent. */
  async connect(): Promise<EventsClient> {
    if (this.eventsClient) return this.eventsClient;
    const socket = new V2Socket({
      baseUrl: this.baseUrl,
      apiPrefix: this.apiPrefix,
      token: this.token,
      wsImpl: this.wsImpl,
      callTimeoutMs: this.callTimeoutMs,
    });
    await socket.connect();
    this.socket = socket;
    this.eventsClient = new EventsClient(socket);
    return this.eventsClient;
  }

  /** The events client. Throws if `connect()` has not been called. */
  get events(): EventsClient {
    if (!this.eventsClient) {
      throw new Error('events not connected — call `await client.connect()` first');
    }
    return this.eventsClient;
  }

  /** Close the WS socket (if open). HTTP RPC is stateless and needs no close. */
  async close(): Promise<void> {
    if (this.socket) {
      await this.socket.close();
      this.socket = null;
      this.eventsClient = null;
    }
  }
}
