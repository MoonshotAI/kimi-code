import type { Message } from '#/llm/message';
import type {
  HookPoint,
  LoopHooks,
  StepStoppingVerdict,
  ToolBatchStartingDecision,
} from '#/loop/contract/hook';
import type { QueuedItem } from '#/loop/contract/inbox';
import type { Cause } from '#/loop/contract/outcome';
import { hookFailureCause } from '#/hook/loop/failure';
import {
  isMessageAppendingDecision,
  isStepContinuingVerdict,
  isStepStartingDecision,
  isStepStoppingVerdict,
  isToolBatchStartingDecision,
  isTurnStartingVerdict,
  type HookRun,
} from '#/hook/loop/run';
import {
  createHookRegistry,
  type HookChainControl,
  type HookChains,
  type HookItem,
  type HookRegistrar,
  type HookRegistry,
} from '#/hook/registry';
import { wrapHookChainResult, type HookFailure } from '#/hook/result';

interface ItemRun<D> {
  decision?: D;
  failure?: HookFailure;
  blocked?: Cause;
}

function itemFailure(item: HookItem, control: HookChainControl, error: unknown): ItemRun<never> {
  const blocking = item.onFailure === 'block';
  return {
    failure: {
      hookId: item.id,
      error,
      paused: !blocking,
      blocking,
      suspend: blocking ? undefined : () => { control.suspend(item); },
    },
    blocked: blocking ? hookFailureCause(item.point as HookPoint, error, item.id) : undefined,
  };
}

function itemDecision<D>(
  item: HookItem,
  control: HookChainControl,
  value: unknown,
  isValid: (value: unknown) => value is D,
): ItemRun<D> {
  try {
    if (value === undefined) return {};
    if (isValid(value)) return { decision: value };
    throw new Error(`invalid ${item.point} hook result`);
  } catch (error) {
    return itemFailure(item, control, error);
  }
}

async function runItem<D>(
  item: HookItem,
  control: HookChainControl,
  args: readonly unknown[],
  isValid: (value: unknown) => value is D,
): Promise<ItemRun<D>> {
  try {
    const value = await control.invoke(item, args);
    return itemDecision(item, control, value, isValid);
  } catch (error) {
    return itemFailure(item, control, error);
  }
}

function signed(cause: Cause, item: HookItem): Cause {
  return cause.by === undefined ? { ...cause, by: item.id } : cause;
}

async function runFirst<D extends { readonly cause: Cause }, R>(
  items: readonly HookItem[],
  args: readonly unknown[],
  control: HookChainControl,
  isValid: (value: unknown) => value is D,
  map: (run: HookRun<D>) => R,
): Promise<R> {
  const failures: HookFailure[] = [];
  for (const item of items) {
    const run = await runItem(item, control, args, isValid);
    if (run.failure !== undefined) failures.push(run.failure);
    if (run.decision !== undefined) {
      return map({ decision: { ...run.decision, cause: signed(run.decision.cause, item) }, failures });
    }
    if (run.blocked !== undefined) return map({ blocked: run.blocked, failures });
  }
  return map({ failures });
}

function firstResult<D extends { readonly cause: Cause }>(
  run: HookRun<D>,
  blocked: (cause: Cause) => D,
): D {
  if (run.decision !== undefined) return wrapHookChainResult({ decision: run.decision, failures: run.failures });
  if (run.blocked !== undefined) return wrapHookChainResult({ decision: blocked(run.blocked), failures: run.failures });
  return wrapHookChainResult({ failures: run.failures });
}

const chains: HookChains<LoopHooks> = {
  'turn.starting': (items, [event, signal], control) =>
    runFirst(items, [event, signal], control, isTurnStartingVerdict, (run) =>
      firstResult(run, (cause) => ({ type: 'blocked' as const, cause }))),
  'message.appending': async (items, [event, signal], control) => {
    const failures: HookFailure[] = [];
    let message: Message = event.item.message;
    for (const item of items) {
      const current = { ...event, item: { ...event.item, message } as QueuedItem };
      const run = await runItem(item, control, [current, signal], isMessageAppendingDecision);
      if (run.failure !== undefined) failures.push(run.failure);
      message = run.decision?.message ?? message;
      const decided = run.decision?.blocked;
      const blocked = decided === undefined ? run.blocked : signed(decided, item);
      if (blocked !== undefined) {
        return wrapHookChainResult({ decision: { message, blocked }, failures });
      }
    }
    return message === event.item.message && failures.length === 0
      ? undefined
      : wrapHookChainResult({ decision: { message }, failures });
  },
  'step.starting': async (items, [event, signal], control) => {
    const failures: HookFailure[] = [];
    for (const item of items) {
      const run = await runItem(item, control, [event, signal], isStepStartingDecision);
      if (run.failure !== undefined) failures.push(run.failure);
      const decided = run.decision?.blocked;
      const blocked = decided === undefined ? run.blocked : signed(decided, item);
      if (blocked !== undefined) {
        const turnOutcome = run.decision?.turnOutcome;
        return wrapHookChainResult({
          decision: { blocked, ...(turnOutcome === undefined ? {} : { turnOutcome }) },
          failures,
        });
      }
    }
    return wrapHookChainResult({ failures });
  },
  'tool.batch-starting': async (items, [event, signal], control) => {
    const failures: HookFailure[] = [];
    for (const item of items) {
      const run = await runItem(item, control, [event, signal], isToolBatchStartingDecision);
      if (run.failure !== undefined) failures.push(run.failure);
      if (run.decision !== undefined) {
        return wrapHookChainResult({
          decision: { blocked: signed(run.decision.blocked, item), result: run.decision.result },
          failures,
        });
      }
      if (run.blocked !== undefined) {
        return wrapHookChainResult<ToolBatchStartingDecision>({ decision: { blocked: run.blocked }, failures });
      }
    }
    return wrapHookChainResult({ failures });
  },
  'step.stopping': (items, [event, signal], control) =>
    runFirst(items, [event, signal], control, isStepStoppingVerdict, (run) => {
      if (run.decision !== undefined) {
        return wrapHookChainResult({ decision: run.decision, failures: run.failures });
      }
      return wrapHookChainResult<StepStoppingVerdict | void>({ blocked: run.blocked, failures: run.failures });
    }),
  'step.continuing': (items, [event, signal], control) =>
    runFirst(items, [event, signal], control, isStepContinuingVerdict, (run) =>
      firstResult(run, (cause) => ({ type: 'blocked' as const, cause }))),
};

export type LoopHookRegistry = Omit<HookRegistry<LoopHooks>, 'add'> & {
  readonly hook: LoopHooks;
  readonly addLoopHook: HookRegistrar<LoopHooks, string>;
};

export function createLoopHookRegistry(): LoopHookRegistry {
  const { hook, registry } = createHookRegistry(chains);
  const { add, ...rest } = registry;
  return { ...rest, hook, addLoopHook: add };
}
