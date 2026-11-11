/**
 * `waitForTasks`: waits until one or all detached tool calls finish, or until a timeout.
 */

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

export interface TaskWaitSlot {
  readonly toolCall: { readonly id: string };
  readonly done: boolean;
  readonly waiters: Set<() => void>;
}

export function createWaitForTasks(source: () => readonly TaskWaitSlot[]): WaitForTasks {
  return ({ taskId, timeoutMs }) => {
    const targets = source().filter((slot) => taskId === undefined || slot.toolCall.id === taskId);
    const unknown = taskId !== undefined && targets.length === 0 ? [taskId] : [];
    if (targets.length === 0) {
      return Promise.resolve({ completed: [], running: [], unknown, timedOut: false });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiting: Array<{ slot: (typeof targets)[number]; notify: () => void }> = [];
      const cleanup = (): void => {
        for (const { slot, notify } of waiting) slot.waiters.delete(notify);
        if (timer !== undefined) clearTimeout(timer);
      };
      const settle = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          completed: targets.filter((slot) => slot.done).map((slot) => slot.toolCall.id),
          running: targets.filter((slot) => !slot.done).map((slot) => slot.toolCall.id),
          unknown,
          timedOut,
        });
      };
      for (const slot of targets) waiting.push({ slot, notify: () => settle(false) });
      for (const { slot, notify } of waiting) slot.waiters.add(notify);
      if (targets.some((slot) => slot.done)) {
        settle(false);
        return;
      }
      timer = setTimeout(() => settle(true), timeoutMs);
    });
  };
}
