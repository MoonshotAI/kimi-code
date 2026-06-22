/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../_base/di';
import type { CoreRPC } from '../../rpc';

import { ICoreRuntime } from '../coreProcess/coreProcess';
import { IToolService, toProtocolTool, type AgentCoreToolInfoLike } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreRuntime private readonly core: ICoreRuntime) {
    super();
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    const resolvedSid = sessionId ?? (await this._anyKnownSessionId());
    if (resolvedSid === undefined) return [];
    let raw: readonly unknown[];
    try {
      raw = await this.coreApi().getTools({
        sessionId: resolvedSid,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded into the active session map; return empty rather
      // than surface a 500 — the global-list semantics is "best effort".
      return [];
    }
    return raw.map((t) => toProtocolTool(t as AgentCoreToolInfoLike));
  }

  /**
   * Find a usable session id when caller hasn't supplied one. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.coreApi().listSessions({});
    if (all.length === 0) return undefined;
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
registerSingleton(IToolService, ToolService, InstantiationType.Delayed);
