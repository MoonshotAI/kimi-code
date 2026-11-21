import {
  createHookRegistry,
  type HookChainControl,
  type HookChains,
  type HookItem,
  type HookRegistry,
} from '#/hook/registry';
import type { TurnHooks } from './contract';

async function firstDecision<F extends (...args: never[]) => unknown>(
  items: readonly HookItem<F>[],
  args: Parameters<F>,
  control: HookChainControl,
): Promise<Awaited<ReturnType<F>>> {
  for (const item of items) {
    const value = await control.invoke(item, args);
    if (value !== undefined) return value as Awaited<ReturnType<F>>;
  }
  return undefined as Awaited<ReturnType<F>>;
}

const chains: HookChains<TurnHooks> = {
  starting: firstDecision,
  requesting: firstDecision,
  continuing: firstDecision,
  ending: async (items, args, control) => {
    for (const item of items) await control.invoke(item, args);
  },
};

export type TurnHookRegistry = Omit<HookRegistry<TurnHooks>, 'add'> & {
  readonly hook: TurnHooks;
  readonly registerTurnHooks: (hooks: TurnHooks) => void;
};

export function createTurnHookRegistry(): TurnHookRegistry {
  const { hook, registry } = createHookRegistry(chains);
  const { add, ...rest } = registry;
  let registered = false;
  return {
    ...rest,
    hook,
    registerTurnHooks(hooks) {
      if (registered) throw new Error('turn hooks already registered');
      registered = true;
      for (const point of Object.keys(hooks) as (keyof TurnHooks)[]) {
        add({ point, hook: hooks[point] });
      }
    },
  };
}
