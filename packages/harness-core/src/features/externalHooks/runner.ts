import { computed, createFacadeToken } from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/index';

import { blockDecision, indexHooks, runMatchedHooks } from './internal/match';
import type {
  HookBlockDecision,
  HookDef,
  HookMatcherValue,
  HookResult,
} from './internal/types';

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

export interface CreateExternalHooksRunnerDeps {
  readonly host: OsHost;
  readonly hooks: () => readonly HookDef[];
  readonly workDir?: string;
  readonly clientType?: string;
  readonly shell?: string;
}

export function createExternalHooksRunner(
  deps: CreateExternalHooksRunnerDeps,
): ExternalHooksRunner {
  const byEvent = computed(() => indexHooks(deps.hooks()));
  const triggerInner = (
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookResult[]> =>
    runMatchedHooks(
      deps.host.process,
      byEvent.value,
      event,
      {
        cwd: args.cwd ?? deps.workDir,
        ...args,
        inputData: {
          clientType: deps.clientType,
          ...args.inputData,
        },
      },
      {},
      deps.shell,
    );
  const trigger = (
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookResult[]> => {
    try {
      return triggerInner(event, args).catch((): HookResult[] => []);
    } catch {
      return Promise.resolve([]);
    }
  };
  return {
    get summary() {
      const result: Record<string, number> = {};
      for (const [event, hooks] of byEvent.value.entries()) {
        result[event] = hooks.length;
      }
      return result;
    },
    trigger,
    triggerBlock: async (event, args = {}) => blockDecision(event, await trigger(event, args)),
    fireAndForgetTrigger: (event, args = {}) => {
      try {
        return trigger(event, args).catch((): HookResult[] => []);
      } catch {
        return Promise.resolve([]);
      }
    },
    hasHooksFor: (event) => (byEvent.value.get(event)?.length ?? 0) > 0,
  };
}
