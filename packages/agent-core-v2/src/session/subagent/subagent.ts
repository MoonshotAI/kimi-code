import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { Turn } from '#/agent/loop/loop';
import type { Hooks } from '#/hooks';

import type {
  SpawnSubagentOptions,
  SpawnedSubagent,
  SubagentSpawnPlan,
  SubagentSpawnPlanInput,
} from './spawn';

export type AgentRunRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface RunAgentOptions {
  readonly signal: AbortSignal;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  readonly onReady?: () => void;
}

export interface AgentRunHandle {
  readonly agentId: string;
  readonly turn: Turn;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
};

export interface ISessionSubagentService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<AgentTaskHooks>;

  readonly onDidStopAgentTask: Event<AgentTaskStopHookContext>;

  run(agent: AgentContext, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;

  planSpawn(input: SubagentSpawnPlanInput): Promise<SubagentSpawnPlan>;

  spawn(opts: SpawnSubagentOptions): Promise<SpawnedSubagent>;

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
}

export const ISessionSubagentService: ServiceIdentifier<ISessionSubagentService> =
  createDecorator<ISessionSubagentService>('sessionSubagentService');
