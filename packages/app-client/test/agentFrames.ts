import type { AppAgentState } from '@moonshot-ai/app-core/api';

const IDLE: AppAgentState = { status: 'idle', compacting: false, planMode: false, swarmMode: false, towerMode: false };

export function agentState(status: AppAgentState['status'], extra: Partial<AppAgentState> = {}): AppAgentState {
  return { ...IDLE, status, ...extra };
}
