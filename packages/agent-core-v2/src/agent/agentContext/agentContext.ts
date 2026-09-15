import type { AgentSpace } from './agentSpace';

export interface AgentContext {
  readonly agentId: string;
  readonly generation: number;
  readonly space: AgentSpace;
}
