import {
  createHookRegistry,
  type HookChainControl,
  type HookChains,
  type HookItem,
  type HookRegistrar,
  type HookRegistry,
} from '#/hook/registry';
import { isPromiseLike } from '#/hook/result';
import type { TurnHooks } from './contract';

function firstDecision<F extends (...args: never[]) => unknown>(
  items: readonly HookItem<F>[],
  args: Parameters<F>,
  control: HookChainControl,
): ReturnType<F> | Promise<Awaited<ReturnType<F>>> {
  const visit = (index: number): unknown => {
    if (index >= items.length) return undefined;
    const item = items[index]!;
    const value = control.invoke(item, args);
    if (isPromiseLike(value)) {
      return Promise.resolve(value).then((resolved) => resolved === undefined ? visit(index + 1) : resolved);
    }
    return value === undefined ? visit(index + 1) : value;
  };
  return visit(0) as ReturnType<F> | Promise<Awaited<ReturnType<F>>>;
}

const chains: HookChains<TurnHooks> = {
  starting: firstDecision,
  requesting: firstDecision,
  continuing: firstDecision,
  ending: (items, args, control) => {
    const visit = (index: number): void | Promise<void> => {
      if (index >= items.length) return;
      const value = control.invoke(items[index]!, args);
      return isPromiseLike(value) ? Promise.resolve(value).then(() => visit(index + 1)) : visit(index + 1);
    };
    return visit(0);
  },
};

export type TurnHookRegistry = Omit<HookRegistry<TurnHooks>, 'add'> & {
  readonly hook: TurnHooks;
  readonly addTurnHook: HookRegistrar<TurnHooks, string>;
};

export function createTurnHookRegistry(): TurnHookRegistry {
  const { hook, registry } = createHookRegistry(chains);
  const { add, ...rest } = registry;
  return { ...rest, hook, addTurnHook: add };
}
