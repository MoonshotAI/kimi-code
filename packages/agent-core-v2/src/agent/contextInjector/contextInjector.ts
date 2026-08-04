import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
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

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;

  register(
    name: string,
    provider: ContextInjectionProvider,
  ): IDisposable;

  injectAfterCompaction(): Promise<void>;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
