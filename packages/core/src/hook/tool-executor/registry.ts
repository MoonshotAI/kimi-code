import type {
  AfterExecuteHookContext,
  ToolDecision,
  ToolExecutorHook,
  ToolResult,
  ToolStartingDecision,
} from '#/tool/types';
import {
  createHookRegistry,
  type HookChains,
  type HookRegistrar,
  type HookRegistry,
} from '#/hook/registry';

export type ToolExecutorHookMap<TContext = unknown, TPrepared = unknown> = Required<
  ToolExecutorHook<TContext, TPrepared>
>;

export type ToolExecutorHookRegistry<TContext = unknown, TPrepared = unknown> = Omit<
  HookRegistry<ToolExecutorHookMap<TContext, TPrepared>>,
  'add'
> & {
  readonly hook: ToolExecutorHook<TContext, TPrepared>;
  readonly addToolHook: HookRegistrar<ToolExecutorHookMap<TContext, TPrepared>, string>;
};

function chains<TContext, TPrepared>(): HookChains<ToolExecutorHookMap<TContext, TPrepared>> {
  return {
    validating(items, [context], control) {
      let current = context;
      let rewritten = false;
      for (const item of items) {
        const decision = control.invoke(item, [current]) as ToolDecision | void;
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        current = Object.assign({}, current, { args: decision.args });
        rewritten = true;
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async starting(items, [context], control) {
      let current = context;
      let rewritten = false;
      for (const item of items) {
        const decision = await control.invoke(item, [current]) as ToolStartingDecision | void;
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        if ('args' in decision) {
          current = Object.assign({}, current, { args: decision.args });
          rewritten = true;
        }
        if ('skipPermitting' in decision) {
          return rewritten ? { skipPermitting: true, args: current.args } : { skipPermitting: true };
        }
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async permitting(items, [context], control) {
      let current = context;
      let rewritten = false;
      for (const item of items) {
        const decision = await control.invoke(item, [current]) as ToolDecision | void;
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        current = Object.assign({}, current, { args: decision.args });
        rewritten = true;
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async beforeExecute(items, [context], control) {
      for (const item of items) await control.invoke(item, [context]);
    },
    async afterExecute(items, [context], control) {
      let current: AfterExecuteHookContext<unknown, TContext, TPrepared> = context;
      let result: ToolResult = context.result;
      for (const item of items) {
        const replaced = await control.invoke(item, [current]) as ToolResult | void;
        if (replaced !== undefined) {
          result = replaced;
          current = Object.assign({}, current, { result });
        }
      }
      return result;
    },
    observe(items, [event], control) {
      for (const item of items) {
        try {
          control.invokeSync(item, [event]);
        } catch {
          continue;
        }
      }
    },
  };
}

export function createToolExecutorHookRegistry<TContext = unknown, TPrepared = unknown>(): ToolExecutorHookRegistry<
  TContext,
  TPrepared
> {
  const { hook, registry } = createHookRegistry(chains<TContext, TPrepared>());
  const { add, ...rest } = registry;
  return { ...rest, hook, addToolHook: add };
}
