/**
 * `McpService` — implementation of `IMcpService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { McpServer } from '@moonshot-ai/protocol';

import type { CoreRPC } from '../../rpc';
import { ICoreRuntime } from '../coreProcess/coreProcess';
import {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

export class McpService extends Disposable implements IMcpService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreRuntime private readonly core: ICoreRuntime) {
    super();
  }

  async list(): Promise<readonly McpServer[]> {
    // `listMcpServers` is on the SessionAPI surface; we need a session id to
    // dispatch. Pick the most recently created one. If no sessions exist,
    // return an empty list (the MCP registrar may have started up but the
    // RPC plumbing isn't reachable until a session is open).
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) return [];
    const raw = await this.coreApi().listMcpServers({ sessionId });
    return raw.map(toProtocolMcpServer);
  }

  async restart(serverId: string): Promise<{ restarting: true }> {
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) {
      // No session => no MCP registrar reachable => server can't be reached.
      throw new McpServerNotFoundError(serverId);
    }
    // Existence check: the wire id is the agent-core `name`. The reconnect
    // call will reject for unknown names; we pre-check so the route can
    // emit a deterministic 40408 envelope without depending on agent-core
    // error message shape.
    const known = await this.coreApi().listMcpServers({ sessionId });
    if (!known.some((s) => s.name === serverId)) {
      throw new McpServerNotFoundError(serverId);
    }
    await this.coreApi().reconnectMcpServer({ sessionId, name: serverId });
    return { restarting: true };
  }

  /**
   * Find a usable session id for dispatching SessionAPI calls. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.coreApi().listSessions({});
    if (all.length === 0) return undefined;
    // Sort by createdAt desc — newest sessions are the most likely to have
    // an active MCP RPC binding.
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site above reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IMcpService, McpService, InstantiationType.Delayed);
