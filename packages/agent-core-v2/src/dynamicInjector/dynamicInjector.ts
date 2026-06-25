import { createDecorator } from "#/_base/di";
import type { IDisposable } from "#/_base/di";

export interface DynamicInjectionContext {
  readonly injectedAt: number | null;
}

export type DynamicInjectionProvider = (
  context: DynamicInjectionContext,
) => string | undefined | Promise<string | undefined>;

export interface IDynamicInjector {
  register(
    variant: string,
    provider: DynamicInjectionProvider,
    options?: DynamicInjectionOptions,
  ): IDisposable;
}

export interface DynamicInjectionOptions {
  readonly cadence?: 'step' | 'turn';
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IDynamicInjector = createDecorator<IDynamicInjector>(
  'agentDynamicInjectorService',
);
