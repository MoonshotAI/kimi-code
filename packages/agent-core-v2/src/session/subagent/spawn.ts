import type { SubagentModelSource } from './configSection';

export const DEFAULT_PROFILE_NAME = 'coder';

export interface SubagentSpawnPlanInput {
  readonly callerAgentId: string;
  readonly profileName?: string;
  readonly model?: string;
}

export interface SubagentSpawnPlan {
  readonly profileName: string;
  readonly model: string;
  readonly modelSource?: SubagentModelSource;
  readonly thinking?: string;
}

export interface SpawnSubagentOptions {
  readonly callerAgentId: string;
  readonly plan: SubagentSpawnPlan;
  readonly labels?: Readonly<Record<string, string>>;
  readonly prompt: string;
}

export interface SpawnedSubagent {
  readonly agentId: string;
  readonly profileName: string;
  readonly model: string;
  readonly modelSource?: SubagentModelSource;
  readonly promptText: string;
}
