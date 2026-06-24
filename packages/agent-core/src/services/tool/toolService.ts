/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';

import { IToolRegistry } from '../agent';
import {
  AgentRuntimeTodoError,
  IAgentRuntimeService,
} from '../agentRuntime/agentRuntime';
import { IToolService, toProtocolTool } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;

  constructor(
    @IAgentRuntimeService private readonly agentRuntimes: IAgentRuntimeService,
  ) {
    super();
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    if (sessionId === undefined) {
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/tool/toolService.ts:list',
        'Session-less tool listing has not been migrated; require a session id or define an agent-runtime backed global source.',
      );
    }
    const runtime = await this.agentRuntimes.get(sessionId, MAIN_AGENT_ID);
    if (runtime !== undefined) {
      return runtime.get(IToolRegistry).list().map((tool) => toProtocolTool(tool));
    }
    throw new AgentRuntimeTodoError(
      'packages/agent-core/src/services/tool/toolService.ts:list',
      `Load session "${sessionId}" through IAgentRuntimeService before listing tools.`,
    );
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IToolService, ToolService, InstantiationType.Delayed);
