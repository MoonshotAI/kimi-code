// apps/kimi-web/src/composables/client/useTaskPoller.ts
// Background task output polling and the 1-second task clock used to keep
// running-task elapsed timers live in the UI.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import type { AppTask } from '../../api/types';
import { keepLiveSubagents } from '../../lib/taskMerge';
import type { ExtendedState } from '../useKimiWebClient';

const TASK_OUTPUT_POLL_INTERVAL_MS = 1000;
const TASK_OUTPUT_POLL_BYTES = 4096;
const TASK_OUTPUT_FINAL_BYTES = 32 * 1024;

export interface UseTaskPoller {
  /** 1-second clock that ticks while an active app task is running. */
  taskClock: Readonly<Ref<number>>;
  /** One-off load of the task list for a session, plus terminal-output backfill. */
  loadTasksForSession: (sessionId: string) => Promise<void>;
}

export function useTaskPoller(
  rawState: ExtendedState,
  activeAppTasks: ComputedRef<AppTask[]>,
): UseTaskPoller {
  let taskOutputPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPolledSessionId: string | undefined;
  const fetchedTerminalTaskOutputIds = new Set<string>();

  async function loadTasksForSession(sessionId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const taskList = await api.listTasks(sessionId);
      rawState.tasksBySession = {
        ...rawState.tasksBySession,
        // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
        [sessionId]: keepLiveSubagents(taskList, rawState.tasksBySession[sessionId] ?? []),
      };
      // Completed tasks may have real terminal output that never streamed over
      // WS. Fetch it once now so the rows are expandable when the session opens.
      await fetchTerminalTaskOutputs(sessionId, taskList);
    } catch {
      // Tasks are side data; old/stale sessions may fail without blocking messages.
    }
  }

  /**
   * Fetch the final output snapshot for terminal tasks that lack real streamed
   * outputLines. Called once after loading the task list so already-completed
   * tasks are clickable immediately.
   */
  async function fetchTerminalTaskOutputs(
    sessionId: string,
    taskList?: AppTask[],
  ): Promise<void> {
    if (rawState.activeSessionId !== sessionId) return;

    const tasks = taskList ?? rawState.tasksBySession[sessionId] ?? [];
    const api = getKimiWebApi();
    const outputByTaskId = new Map<string, { preview: string; bytes?: number }>();

    await Promise.all(
      tasks.map(async (task) => {
        const isTerminal =
          task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
        if (!isTerminal) return;
        if (fetchedTerminalTaskOutputIds.has(task.id)) return;
        if ((task.outputLines?.length ?? 0) > 0) return;

        try {
          const withOutput = await api.getTask(sessionId, task.id, {
            withOutput: true,
            outputBytes: TASK_OUTPUT_FINAL_BYTES,
          });
          if (withOutput.outputPreview !== undefined) {
            outputByTaskId.set(task.id, {
              preview: withOutput.outputPreview,
              bytes: withOutput.outputBytes,
            });
          }
          // Only a definitive response marks the task as fetched — a transient
          // failure must leave it eligible for a later backfill.
          fetchedTerminalTaskOutputIds.add(task.id);
        } catch {
          // Task may have finished between listTasks and getTask; ignore.
        }
      }),
    );

    if (outputByTaskId.size === 0) return;

    const existing = rawState.tasksBySession[sessionId] ?? [];
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sessionId]: existing.map((t) => {
        // Output was fetched by REST task id; a background subagent row folded
        // into its WS agent-id row (keepLiveSubagents) is matched via
        // backgroundTaskId, otherwise its final output would be dropped here
        // and never refetched (the REST id is already marked as fetched).
        const polled =
          outputByTaskId.get(t.id) ??
          (t.backgroundTaskId !== undefined
            ? outputByTaskId.get(t.backgroundTaskId)
            : undefined);
        if (!polled) return t;
        return { ...t, outputPreview: polled.preview, outputBytes: polled.bytes };
      }),
    };
  }

  /**
   * Poll background task output for a session. Mirrors the TUI's 1-second refresh:
   * refresh the task list, then fetch tail output for running tasks and a final
   * snapshot for terminal tasks that haven't received output yet.
   */
  async function pollTaskOutputForSession(sessionId: string): Promise<void> {
    if (rawState.activeSessionId !== sessionId) return;

    const api = getKimiWebApi();
    let taskList: AppTask[];
    try {
      taskList = await api.listTasks(sessionId);
    } catch {
      return;
    }

    const outputByTaskId = new Map<string, { preview: string; bytes?: number }>();

    await Promise.all(
      taskList.map(async (task) => {
        const isRunning = task.status === 'running';
        const isTerminal =
          task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
        if (!isRunning && !isTerminal) return;

        // Running tasks: poll tail continuously. Terminal tasks: fetch a final
        // snapshot once if we have not already received real streamed output.
        // outputPreview may be a placeholder (`$ <command>`) or a partial tail,
        // so we intentionally do not skip terminal tasks just because outputPreview
        // is present.
        if (isTerminal) {
          if (fetchedTerminalTaskOutputIds.has(task.id)) return;
          if ((task.outputLines?.length ?? 0) > 0) return;
        }

        try {
          const withOutput = await api.getTask(sessionId, task.id, {
            withOutput: true,
            outputBytes: isRunning ? TASK_OUTPUT_POLL_BYTES : TASK_OUTPUT_FINAL_BYTES,
          });
          if (withOutput.outputPreview !== undefined) {
            outputByTaskId.set(task.id, {
              preview: withOutput.outputPreview,
              bytes: withOutput.outputBytes,
            });
          }
          // Mark as fetched only on a definitive response; a transient failure
          // stays eligible for the next poll.
          if (isTerminal) {
            fetchedTerminalTaskOutputIds.add(task.id);
          }
        } catch {
          // Task may have finished between listTasks and getTask; ignore.
        }
      }),
    );

    const existing = rawState.tasksBySession[sessionId] ?? [];
    const existingById = new Map(existing.map((t) => [t.id, t] as const));

    const refreshed: AppTask[] = taskList.map((fresh) => {
      const old = existingById.get(fresh.id);
      const polled = outputByTaskId.get(fresh.id);
      return {
        ...fresh,
        // Preserve any WS-driven outputLines / streamed text (future taskProgress events).
        outputLines: old?.outputLines,
        text: old?.text,
        outputPreview: polled?.preview ?? old?.outputPreview,
        outputBytes: polled?.bytes ?? old?.outputBytes,
      };
    });

    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
      [sessionId]: keepLiveSubagents(refreshed, existing),
    };
  }

  function startTaskOutputPolling(sessionId: string): void {
    if (taskOutputPollTimer !== null && lastPolledSessionId === sessionId) {
      return;
    }
    stopTaskOutputPolling();
    lastPolledSessionId = sessionId;
    void pollTaskOutputForSession(sessionId);
    taskOutputPollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      if (rawState.activeSessionId === sessionId) {
        void pollTaskOutputForSession(sessionId);
      } else {
        stopTaskOutputPolling();
      }
    }, TASK_OUTPUT_POLL_INTERVAL_MS);
  }

  function stopTaskOutputPolling(): void {
    if (taskOutputPollTimer !== null) {
      clearInterval(taskOutputPollTimer);
      taskOutputPollTimer = null;
    }
    lastPolledSessionId = undefined;
    fetchedTerminalTaskOutputIds.clear();
  }

  // A 1-second clock that only ticks while a task is running, so a running task's
  // elapsed-time label keeps counting up. UI task mappers read Date.now() once per
  // evaluation; without this the `tasks` computed only re-ran when tasksBySession
  // changed, freezing the timer at whatever it read on the first render.
  const taskClock = ref(0);
  let taskClockTimer: ReturnType<typeof setInterval> | null = null;
  watch(
    () => activeAppTasks.value.some((tk) => tk.status === 'running'),
    (hasRunning) => {
      if (hasRunning && taskClockTimer === null) {
        taskClockTimer = setInterval(() => {
          taskClock.value = (taskClock.value + 1) % Number.MAX_SAFE_INTEGER;
        }, 1000);
      } else if (!hasRunning && taskClockTimer !== null) {
        clearInterval(taskClockTimer);
        taskClockTimer = null;
      }
    },
    { immediate: true },
  );

  // Start/stop task output polling based on whether the active session has
  // running background tasks. This mirrors the TUI's 1-second refresh.
  watch(
    () => {
      const sid = rawState.activeSessionId;
      if (!sid) return { sid: undefined as string | undefined, hasRunning: false };
      const tasks = rawState.tasksBySession[sid] ?? [];
      return { sid, hasRunning: tasks.some((t) => t.status === 'running') };
    },
    ({ sid, hasRunning }, _prev, onCleanup) => {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      if (hasRunning && sid !== undefined) {
        startTaskOutputPolling(sid);
      } else if (sid !== undefined) {
        // All tasks finished — wait a beat to catch final output, then stop.
        cleanupTimer = setTimeout(() => {
          const tasks = rawState.tasksBySession[sid] ?? [];
          if (!tasks.some((t) => t.status === 'running')) {
            stopTaskOutputPolling();
          }
        }, 1500);
      } else {
        stopTaskOutputPolling();
      }
      onCleanup(() => {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      });
    },
    { deep: true, immediate: true },
  );

  return {
    taskClock: computed(() => taskClock.value),
    loadTasksForSession,
  };
}
