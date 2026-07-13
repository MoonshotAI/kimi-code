/**
 * `/api/v2` HTTP transport — `POST`s a `resource:action` to the scope URL and
 * unwraps the envelope. One {@link HttpRpc} is shared by every resource proxy
 * on a client.
 *
 * URL shapes (mirror `server-v2/src/transport/registerRpcRoutes.ts`):
 *   POST /api/v2/<resource>:<action>                                   core
 *   POST /api/v2/session/<session_id>/<resource>:<action>              session
 *   POST /api/v2/session/<session_id>/agent/<agent_id>/<resource>:<action>  agent
 *
 * The server also accepts `GET ?arg=<json>` for `readonly` actions; this
 * transport always POSTs (write actions are POST-only, and POST works for
 * reads too) to keep the client single-path.
 */
import type { Envelope } from '@moonshot-ai/protocol';

import { unwrapData } from '../errors.js';

/** Which scope a call resolves before dispatching. */
export type ScopeKind = 'core' | 'session' | 'agent';

/** Scope-identifying path params. */
export interface ScopeParams {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface HttpRpcOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Default `/api/v2`. */
  readonly apiPrefix?: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** Override `fetch` (testing). */
  readonly fetchImpl?: typeof fetch;
}

export class HttpRpc {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpRpcOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiPrefix = opts.apiPrefix ?? '/api/v2';
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call<T>(
    scope: ScopeKind,
    params: ScopeParams,
    sa: string,
    arg?: unknown,
  ): Promise<T> {
    const url = this.url(scope, params, sa);
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (arg !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(arg);
    }
    if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(url, { method: 'POST', headers, body });
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch (error) {
      throw new Error(
        `server-v2 POST ${sa} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { cause: error },
      );
    }
    return unwrapData<T>(envelope);
  }

  private url(scope: ScopeKind, params: ScopeParams, sa: string): string {
    switch (scope) {
      case 'core':
        return `${this.baseUrl}${this.apiPrefix}/${sa}`;
      case 'session':
        return `${this.baseUrl}${this.apiPrefix}/session/${encodeURIComponent(params.sessionId ?? '')}/${sa}`;
      case 'agent':
        return `${this.baseUrl}${this.apiPrefix}/session/${encodeURIComponent(params.sessionId ?? '')}/agent/${encodeURIComponent(params.agentId ?? '')}/${sa}`;
    }
  }
}
