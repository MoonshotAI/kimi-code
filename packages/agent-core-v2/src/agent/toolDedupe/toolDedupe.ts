/**
 * `toolDedup` domain (L4) — per-turn tool-call deduplication.
 *
 * A self-wiring plugin: it participates in `turn` step boundaries and
 * `IAgentToolExecutorService`'s will/did hooks to suppress same-step duplicates and inject
 * cross-step repeat reminders. No other service injects it — the container
 * constructs it eagerly at Agent scope so its constructor registers the hooks.
 * The only public surface is the read-only `currentStreak` observation; the
 * step/result operations stay private to the service. Agent-scoped — one
 * instance per agent.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ToolDedupOutput = string | ContentPart[];

export interface ToolDedupSuccessResult {
  readonly output: ToolDedupOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ToolDedupErrorResult {
  readonly output: ToolDedupOutput;
  readonly isError: true;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ToolDedupResult = ToolDedupSuccessResult | ToolDedupErrorResult;

export interface IAgentToolDedupeService {
  readonly _serviceBrand: undefined;
  readonly currentStreak: number;
}

export const IAgentToolDedupeService: ServiceIdentifier<IAgentToolDedupeService> =
  createDecorator<IAgentToolDedupeService>('agentToolDedupeService');
