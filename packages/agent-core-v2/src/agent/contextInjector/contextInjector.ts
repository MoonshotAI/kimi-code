import { createDecorator } from "#/_base/di";
import type { IDisposable } from "#/_base/di";

export interface ContextInjectionContext {
  /** Live positions of this variant's injections in the current history, ascending. */
  readonly injectedPositions: readonly number[];
  /** Position of the newest live injection; `null` when none survive. */
  readonly lastInjectedAt: number | null;
}

export interface ContextInjectionOptions {
  readonly cadence?: 'step' | 'turn';
}

export type ContextInjectionProvider = (
  context: ContextInjectionContext,
) => string | undefined | Promise<string | undefined>;

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;

  register(
    variant: string,
    provider: ContextInjectionProvider,
    options?: ContextInjectionOptions,
  ): IDisposable;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
