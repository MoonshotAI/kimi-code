import type {
  AfterExecuteHookContext,
  ToolDecision,
  ToolDecisionContext,
  ToolExecutorHook,
  ToolStartingDecision,
} from './types';

export function composeToolExecutorHooks<TContext = unknown, TPrepared = unknown>(
  hooks: readonly ToolExecutorHook<TContext, TPrepared>[],
): ToolExecutorHook<TContext, TPrepared> {
  return {
    async validating(context) {
      let current = context;
      let rewritten = false;
      for (const hook of hooks) {
        if (hook.validating === undefined) continue;
        const decision = await hook.validating(current);
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        current = { ...current, args: decision.args };
        rewritten = true;
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async starting(context) {
      let current = context;
      let rewritten = false;
      for (const hook of hooks) {
        if (hook.starting === undefined) continue;
        const decision = await hook.starting.call(hook, current);
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        if ('args' in decision) {
          current = { ...current, args: decision.args };
          rewritten = true;
        }
        if ('skipPermitting' in decision) {
          return rewritten ? { skipPermitting: true, args: current.args } : { skipPermitting: true };
        }
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async permitting(context) {
      let current = context;
      let rewritten = false;
      for (const hook of hooks) {
        if (hook.permitting === undefined) continue;
        const decision = await hook.permitting.call(hook, current);
        if (decision === undefined) continue;
        if ('reject' in decision) return decision;
        current = { ...current, args: decision.args };
        rewritten = true;
      }
      return rewritten ? { args: current.args } : undefined;
    },
    async beforeExecute(context) {
      for (const hook of hooks) {
        await hook.beforeExecute?.call(hook, context);
      }
    },
    async afterExecute(context) {
      let current: AfterExecuteHookContext<any, TContext, TPrepared> = context;
      let result = context.result;
      for (const hook of hooks) {
        if (hook.afterExecute === undefined) continue;
        const replaced = await hook.afterExecute.call(hook, current);
        if (replaced !== undefined) {
          result = replaced;
          current = { ...current, result };
        }
      }
      return result;
    },
    observe(event) {
      for (const hook of hooks) {
        try {
          hook.observe?.call(hook, event);
        } catch {
          continue;
        }
      }
    },
  };
}

export type {
  AfterExecuteHookContext,
  ToolDecision,
  ToolDecisionContext,
  ToolStartingDecision,
};
