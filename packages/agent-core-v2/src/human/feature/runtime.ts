import { createToken } from '#/kernel/index';
import type { AgentPluginTarget } from '#/plugin';

export interface AgentContextValue {
  readonly sessionId: string;
  readonly agentId: string;
}

export const AgentContext = createToken<AgentContextValue>('AgentContext');

export const AgentRuntime = createToken<AgentPluginTarget>('AgentRuntime');
