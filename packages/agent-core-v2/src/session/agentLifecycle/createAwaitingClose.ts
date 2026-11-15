import { ErrorCodes, isError2 } from '#/errors';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { resolveSubagentScopeEvictTimeoutMs } from '#/session/subagent/subagentScopeCache';

import type { CreateAgentOptions, IAgentLifecycleService } from './agentLifecycle';

const CLOSE_WAIT_POLL_MS = 50;

export async function createAgentAwaitingClose(
  lifecycle: IAgentLifecycleService,
  opts: CreateAgentOptions,
  signal?: AbortSignal,
): Promise<AgentContext> {
  const deadline = Date.now() + resolveSubagentScopeEvictTimeoutMs();
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await lifecycle.create(opts);
    } catch (error) {
      const closing = isError2(error) && error.code === ErrorCodes.AGENT_ALREADY_EXISTS;
      if (!closing || Date.now() >= deadline) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, CLOSE_WAIT_POLL_MS);
      });
    }
  }
}
