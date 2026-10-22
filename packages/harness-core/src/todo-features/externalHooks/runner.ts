import { createFacadeToken } from '#/composition-api/index';

import type { HookBlockDecision, HookMatcherValue, HookResult } from './internal/types';

export interface ExternalHooksRunnerTriggerArgs {
  readonly matcherValue?: HookMatcherValue;
  readonly inputData?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly sessionId?: string;
}

export interface ExternalHooksRunner {
  readonly summary: Record<string, number>;
  trigger(event: string, args?: ExternalHooksRunnerTriggerArgs): Promise<HookResult[]>;
  triggerBlock(
    event: string,
    args?: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookBlockDecision | undefined>;
  fireAndForgetTrigger(event: string, args?: ExternalHooksRunnerTriggerArgs): Promise<HookResult[]>;
  hasHooksFor(event: string): boolean;
}

export const ExternalHooksRunnerRef = createFacadeToken<ExternalHooksRunner>('externalHooks.runner');
