import { waitFor } from 'xstate';

import type { ToolCall } from '#/llm/message';
import type { ToolActorRef } from './machine';

export interface TaskWaitInput {
  taskId?: string;
  timeoutMs: number;
}

export interface TaskWaitOutcome {
  completed: string[];
  running: string[];
  unknown: string[];
  timedOut: boolean;
}

export type WaitForTasks = (input: TaskWaitInput) => Promise<TaskWaitOutcome>;

interface LoopSnapshotSource {
  getSnapshot(): {
    context: { tools: Record<string, { ref: ToolActorRef; toolCall: ToolCall; detached: boolean }> };
  };
}

export function createWaitForTasks(self: LoopSnapshotSource): WaitForTasks {
  return async ({ taskId, timeoutMs }) => {
    const detached = Object.values(self.getSnapshot().context.tools).filter((slot) => slot.detached);
    const targets = (taskId === undefined ? detached : detached.filter((slot) => slot.toolCall.id === taskId)).map(
      (slot) => ({ id: slot.toolCall.id, ref: slot.ref }),
    );
    const unknown = taskId !== undefined && targets.length === 0 ? [taskId] : [];
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
