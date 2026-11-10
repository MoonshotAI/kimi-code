import { waitFor, type ActorRefFrom } from '#/xstate2';

import type { TaskWaitInput, TaskWaitOutcome } from '#/tool/executor';
import { createToolMachine } from '#/tool/machine';

export type ToolActorRef = ActorRefFrom<ReturnType<typeof createToolMachine>>;

interface WaitForTarget {
  id: string;
  ref: ToolActorRef;
}

interface AgentSnapshotSource {
  getSnapshot(): {
    context: {
      background: Record<string, { ref: ToolActorRef }>;
    };
  };
}

export function createWaitForTasks(
  self: AgentSnapshotSource,
): (input: TaskWaitInput) => Promise<TaskWaitOutcome> {
  return async ({ taskId, timeoutMs }) => {
    const { background } = self.getSnapshot().context;
    const targets: WaitForTarget[] = [];
    const unknown: string[] = [];
    const ids = taskId === undefined ? Object.keys(background) : [taskId];
    for (const id of ids) {
      const ref = background[id]?.ref;
      if (ref === undefined) {
        unknown.push(id);
      } else {
        targets.push({ id, ref });
      }
    }
    if (targets.length === 0) {
      return { completed: [], running: [], unknown, timedOut: false };
    }
    const waitForAny = () =>
      Promise.any(
        targets.map(({ ref }) =>
          waitFor(ref, (snapshot) => snapshot.status === 'done').catch(() => undefined),
        ),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const timedOut =
      (await Promise.race([waitForAny().then(() => 'done' as const), timeout])) === 'timeout';
    clearTimeout(timer);
    const completed = targets
      .filter(({ ref }) => ref.getSnapshot().status === 'done')
      .map(({ id }) => id);
    const running = targets
      .filter(({ ref }) => ref.getSnapshot().status !== 'done')
      .map(({ id }) => id);
    return { completed, running, unknown, timedOut };
  };
}
