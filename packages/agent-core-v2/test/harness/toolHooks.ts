import { createToolExecutorHookRegistry } from '@moonshot-ai/core/hook';
import type { ToolExecutorHook } from '#/tool/executor';

export function toolExecutorHook<TContext, TPrepared>(
  hooks: readonly ToolExecutorHook<TContext, TPrepared>[],
): ToolExecutorHook<TContext, TPrepared> {
  const registry = createToolExecutorHookRegistry<TContext, TPrepared>();
  for (const hook of hooks) {
    if (hook.validating !== undefined) registry.addToolHook({ point: 'validating', hook: hook.validating.bind(hook) });
    if (hook.starting !== undefined) registry.addToolHook({ point: 'starting', hook: hook.starting.bind(hook) });
    if (hook.permitting !== undefined) registry.addToolHook({ point: 'permitting', hook: hook.permitting.bind(hook) });
    if (hook.beforeExecute !== undefined) {
      registry.addToolHook({ point: 'beforeExecute', hook: hook.beforeExecute.bind(hook) });
    }
    if (hook.afterExecute !== undefined) {
      registry.addToolHook({ point: 'afterExecute', hook: hook.afterExecute.bind(hook) });
    }
    if (hook.observe !== undefined) registry.addToolHook({ point: 'observe', hook: hook.observe.bind(hook) });
  }
  return registry.hook;
}
