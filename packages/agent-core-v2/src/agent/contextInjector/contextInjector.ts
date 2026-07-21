import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
import type { ContentPart } from "#/kosong/contract/message";

export interface ContextInjectionContext {
  readonly injectedPositions: readonly number[];
  readonly lastInjectedAt: number | null;
  readonly isNewTurn: boolean;
}

export type ContextInjectionContent = string | readonly ContentPart[];

export type ContextInjectionProvider = (
  context: ContextInjectionContext,
) => ContextInjectionContent | undefined | Promise<ContextInjectionContent | undefined>;

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
