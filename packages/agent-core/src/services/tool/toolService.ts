/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable, registerSingleton, SyncDescriptor } from '../../di';

import {
  IAgentRuntimeService,
  toAgentRuntimeService,
  type AgentRuntimeServiceSource,
} from '../agentRuntime/agentRuntime';
import { IToolService, toProtocolTool } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;
  private readonly agentRuntimes: IAgentRuntimeService;

  constructor(
    @IAgentRuntimeService agentRuntimes: AgentRuntimeServiceSource,
  ) {
    super();
    this.agentRuntimes = toAgentRuntimeService(agentRuntimes);
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    const resolvedSessionId = sessionId ?? await this.anyKnownSessionId();
    if (resolvedSessionId === undefined) return [];
    const rpc = await this.agentRuntimes.getRPC(resolvedSessionId, MAIN_AGENT_ID);
    if (rpc === undefined) {
      return [];
    }
    return (await rpc.getTools({})).map((tool) => toProtocolTool(tool));
  }

  private async anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.agentRuntimes.listSessionSummaries();
    if (all.length === 0) return undefined;
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(
  IToolService,
  new SyncDescriptor(ToolService, [], true),
);
