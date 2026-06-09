/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IToolService, toProtocolTool, type AgentCoreToolInfoLike } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    const resolvedSid = sessionId ?? (await this._anyKnownSessionId());
    if (resolvedSid === undefined) return [];
    let raw: readonly unknown[];
    try {
      raw = await this.core.rpc.getTools({
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
    const all = await this.core.rpc.listSessions({});
    if (all.length === 0) return undefined;
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IToolService, ToolService, InstantiationType.Delayed);
