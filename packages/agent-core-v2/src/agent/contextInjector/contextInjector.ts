import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
import type { Event } from "#/_base/event";
import type { ContentPart } from "#/kosong/contract/message";
import type { ContextInjectionDisclosure, ContextMessage } from '#/agent/contextMemory/types';

export interface ContextInjectionContext {
  readonly injectedPositions: readonly number[];
  readonly lastInjectedAt: number | null;
  readonly lastInjection?: ContextMessage;
  readonly lastDisclosure?: ContextInjectionDisclosure;
  readonly isNewTurn: boolean;
}

export type ContextInjectionContent = string | readonly ContentPart[];

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

  /** Fired synchronously at every injection boundary (turn start, step,
   * compaction follow-up, wire restore) before any provider runs. This is
   * where boundary participants such as the once-reminder queue drain. */
  readonly onWillInject: Event<void>;

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
