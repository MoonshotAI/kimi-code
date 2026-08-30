import { toDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentFullCompaction,
  type FullCompactionRuntime,
  type FullCompactionStatus,
  type FullCompactionTask,
} from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeProvider,
} from '#/actor/agentRuntime';

export function stubFullCompactionRuntime(
  overrides: Partial<FullCompactionRuntime> = {},
): FullCompactionRuntime {
  const base: FullCompactionRuntime = {
    begin: (): Promise<FullCompactionTask> =>
      Promise.resolve({ id: 'compaction-1', status: 'idle' }),
    cancel: () => Promise.resolve(),
    status: (): FullCompactionStatus => 'idle',
    runningSince: () => undefined,
    onDidFinish: Event.None as FullCompactionRuntime['onDidFinish'],
    registerBeforeCompactHook: () => toDisposable(() => {}),
  };
  return { ...base, ...overrides };
}

export function lifecycleWithFullCompaction(
  fullCompaction: FullCompactionRuntime | (() => FullCompactionRuntime),
  inner?: IAgentLifecycleService,
): IAgentLifecycleService {
  const resolveFullCompaction = (): FullCompactionRuntime =>
    typeof fullCompaction === 'function' ? fullCompaction() : fullCompaction;
  return {
    resolve: (agent: unknown, definition: unknown) => {
      if (definition === AgentFullCompaction) return resolveFullCompaction();
      return inner?.resolve(agent as never, definition as never);
    },
    get: (agentId: unknown) => inner?.get(agentId as never),
    onDidCreate: (listener: (event: unknown) => void) =>
      inner?.onDidCreate?.(listener as never) ?? toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}

export function stubFullCompactionRuntimeProvider(
  runtime: () => FullCompactionRuntime = stubFullCompactionRuntime,
): AgentRuntimeProvider<FullCompactionRuntime> {
  return defineAgentRuntimeProvider(AgentFullCompaction, {
    id: 'fullCompaction',
    createApi: () => runtime(),
  });
}
