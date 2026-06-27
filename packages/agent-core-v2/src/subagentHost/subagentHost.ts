import { createDecorator } from "#/_base/di";
import type { TokenUsage } from '@moonshot-ai/kosong';
import type { QueuedSubagentTask, SubagentResult } from './subagent-batch';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<{
    readonly result: string;
    readonly usage?: TokenUsage;
  }>;
};

export interface SessionSubagentHost {
  getSwarmItem(agentId: string): string | undefined;
  startBtw(): Promise<string>;
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  getProfileName(agentId: string): Promise<string | undefined>;
  markActiveChildDetached(agentId: string): void;
  runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>>;
}

export type QueuedSubagentRunResult<T = unknown> = SubagentResult<T>;
export type { QueuedSubagentTask };

export interface ISubagentHost {
  readonly _serviceBrand: undefined;
  getSwarmItem(agentId: string): string | undefined;
  startBtw(): Promise<string>;
  generateAgentsMd(): Promise<void>;
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  getProfileName(agentId: string): Promise<string | undefined>;
  markActiveChildDetached(agentId: string): void;
  runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>>;
}


export const ISubagentHost = createDecorator<ISubagentHost>('agentSubagentHostService');
