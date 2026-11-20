import { createLoopHookRegistry, type LoopHookRegistry } from '@moonshot-ai/core/hook/loop/registry';
import type { HookRegistration } from '@moonshot-ai/core/hook/registry';
import type { LoopHooks } from '@moonshot-ai/core/loop/contract/hook';
import { createLoop, type CreateLoopOptions, type Loop } from '@moonshot-ai/core/loop/index';

type TestLoopOptions = Omit<CreateLoopOptions, 'hook'> & {
  readonly hook?: CreateLoopOptions['hook'];
  readonly hooks?: readonly HookRegistration<LoopHooks>[];
};

const registries = new WeakMap<Loop, LoopHookRegistry>();

export function createTestLoop(options: TestLoopOptions): Loop {
  const { hooks, hook, ...rest } = options;
  if (hooks === undefined) return createLoop({ ...rest, hook });
  const registry = createLoopHookRegistry();
  for (const registration of hooks) {
    registry.addLoopHook(registration as never);
  }
  const loop = createLoop({ ...rest, hook: registry.hook });
  registries.set(loop, registry);
  return loop;
}

export function loopHookRegistry(loop: Loop): LoopHookRegistry {
  const registry = registries.get(loop);
  if (registry === undefined) throw new Error('test loop has no hook registry');
  return registry;
}
