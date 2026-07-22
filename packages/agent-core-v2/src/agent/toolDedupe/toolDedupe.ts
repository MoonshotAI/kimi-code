/**
 * `toolDedupe` domain (L4) — per-turn tool-call deduplication.
 *
 * A self-wiring plugin: it participates in `turn` step boundaries and
 * `IAgentToolExecutorService`'s will/did hooks to suppress same-step duplicates and inject
 * cross-step repeat reminders. No other service injects it — the container
 * constructs it eagerly at Agent scope so its constructor registers the hooks.
 * Agent-scoped — one instance per agent.
 */

import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ToolDedupeOutput = string | ContentPart[];

export interface ToolDedupeSuccessResult {
  readonly output: ToolDedupeOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ToolDedupeErrorResult {
  readonly output: ToolDedupeOutput;
  readonly isError: true;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ToolDedupeResult = ToolDedupeSuccessResult | ToolDedupeErrorResult;

export interface IAgentToolDedupeService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolDedupeService: ServiceIdentifier<IAgentToolDedupeService> =
  createDecorator<IAgentToolDedupeService>('agentToolDedupeService');
