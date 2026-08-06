import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
import type { ContentPart } from "#/kosong/contract/message";
import type { Tool } from "#/kosong/contract/tool";
import type { ContextInjectionDisclosure, ContextMessage } from '#/agent/contextMemory/types';

export interface ContextInjectionContext {
  readonly injectedPositions: readonly number[];
  readonly lastInjectedAt: number | null;
  readonly lastInjection?: ContextMessage;
  readonly lastDisclosure?: ContextInjectionDisclosure;
  readonly isNewTurn: boolean;
}

export interface ContextInjectionMessage {
  readonly role: 'user' | 'system';
  readonly content: readonly ContentPart[];
  readonly tools?: readonly Tool[];
}

export type ContextInjectionContent =
  | string
  | readonly ContentPart[]
  | { readonly message: ContextInjectionMessage };

export interface ContextInjectionResult {
  readonly content: ContextInjectionContent;
  readonly disclosure?: ContextInjectionDisclosure;
}

export type ContextInjectionProvider = (
  context: ContextInjectionContext,
) =>
  | ContextInjectionContent
  | ContextInjectionResult
  | undefined
  | Promise<ContextInjectionContent | ContextInjectionResult | undefined>;

export type SyncContextInjectionProvider = (
  context: ContextInjectionContext,
) => ContextInjectionContent | ContextInjectionResult | undefined;

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;

  /** Registers a past-tense, exactly-once delivery channel (such as the
   * `reminderQueue`) drained synchronously at every injection boundary
   * (turn start, step, compaction follow-up, wire restore) before any
   * provider runs. A drain that throws or returns a Promise is logged and
   * skipped, so one bad channel cannot starve the rest. */
  registerOnceChannel(name: string, drain: () => void): IDisposable;

  register(
    name: string,
    provider: ContextInjectionProvider,
  ): IDisposable;

  registerAtTurnStart(
    name: string,
    provider: SyncContextInjectionProvider,
  ): IDisposable;

  injectAfterCompaction(): Promise<void>;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
