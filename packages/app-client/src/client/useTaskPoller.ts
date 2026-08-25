// packages/app-client/src/client/useTaskPoller.ts
// Background task output polling and the 1-second task clock used to keep
// running-task elapsed timers live in the UI.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { AppTask, KimiWebApi } from '@moonshot-ai/app-core/api';
import { keepLiveSubagents } from '@moonshot-ai/app-core/lib';
import type { ExtendedState } from './types';

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
  deps: { api: KimiWebApi },
): UseTaskPoller {
  let taskOutputPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPolledSessionId: string | undefined;
  const fetchedTerminalTaskOutputIds = new Set<string>();

  async function loadTasksForSession(sessionId: string): Promise<void> {
    try {
      const api = deps.api;
      const taskList = await api.listTasks(sessionId);
      const existing = rawState.tasksBySession[sessionId] ?? [];
      const existingById = new Map(existing.map((t) => [t.id, t] as const));
      // A background subagent's live WS row is keyed by its agent id while
      // REST lists it under the background-task id (backgroundTaskId links
      // the two) — match by both, or folded rows never merge anything.
      const existingByBackgroundId = new Map(
        existing
          .filter((t) => t.backgroundTaskId !== undefined)
          .map((t) => [t.backgroundTaskId!, t] as const),
      );
      // Preserve the locally observed completion stamp across the reload — an
      // old daemon can omit completed_at on terminal rows, and dropping the
      // stamp here re-sorts a just-cancelled task back by createdAt, hiding
      // it from the default view. Same transition stamping as the poll path:
      // a task that finished while the user was away (old daemon also drops
      // the end event) shows as running → terminal here and must not fall
      // back to its much older createdAt either.
      const merged = taskList.map((fresh) => {
        const old = existingById.get(fresh.id) ?? existingByBackgroundId.get(fresh.id);
        const estimated =
          fresh.completedAt === undefined &&
          old?.completedAt === undefined &&
          old?.status === 'running' &&
          fresh.status !== 'running';
        return {
          ...fresh,
          completedAt:
            fresh.completedAt ?? old?.completedAt ?? (estimated ? new Date().toISOString() : undefined),
          // The marker follows whichever stamp won: a real daemon time clears
          // it; only the synthetic observed stamp sets it.
          completedAtEstimated:
            fresh.completedAt !== undefined
              ? undefined
              : old?.completedAt !== undefined
                ? old.completedAtEstimated
                : estimated
                  ? true
                  : undefined,
        };
      });
      rawState.tasksBySession = {
        ...rawState.tasksBySession,
        // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
        [sessionId]: keepLiveSubagents(merged, existing),
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
    const api = deps.api;
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
   * snapshot for terminal tasks that haven't received output yet. Resolves
   * whether REST itself shows no running tasks left — a lagging /tasks returning
   * `running` right after the transcript settled must not retire the polling
   * (the terminal fetch would be lost for good).
   */
  async function pollTaskOutputForSession(sessionId: string): Promise<boolean> {
    if (rawState.activeSessionId !== sessionId) return true;

    const api = deps.api;
    let taskList: AppTask[];
    try {
      taskList = await api.listTasks(sessionId);
    } catch {
      return false;
    }
    const restIdle = !taskList.some((task) => task.status === 'running');

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
    // A background subagent's live WS row is keyed by its agent id while REST
    // lists it under the background-task id (backgroundTaskId links the two)
    // — match by both, or the running → terminal stamping below never fires
    // for folded rows on old daemons that also drop the end event.
    const existingByBackgroundId = new Map(
      existing
        .filter((t) => t.backgroundTaskId !== undefined)
        .map((t) => [t.backgroundTaskId!, t] as const),
    );

    const refreshed: AppTask[] = taskList.map((fresh) => {
      const old = existingById.get(fresh.id) ?? existingByBackgroundId.get(fresh.id);
      const polled = outputByTaskId.get(fresh.id);
      const estimated =
        fresh.completedAt === undefined &&
        old?.completedAt === undefined &&
        old?.status === 'running' &&
        fresh.status !== 'running';
      return {
        ...fresh,
        // Preserve any WS-driven outputLines / streamed text (future taskProgress events).
        outputLines: old?.outputLines,
        text: old?.text,
        // Preserve the observed completion stamp too — an old daemon can omit
        // completed_at on terminal rows. Stamp only an observed transition
        // (running → terminal): blanketing every historical terminal row with
        // the same "now" would degenerate the recency sort back to creation
        // order, and those rows fall back to createdAt on their own.
        completedAt:
          fresh.completedAt ?? old?.completedAt ?? (estimated ? new Date().toISOString() : undefined),
        // The marker follows whichever stamp won: a real daemon time clears
        // it; only the synthetic observed stamp sets it.
        completedAtEstimated:
          fresh.completedAt !== undefined
            ? undefined
            : old?.completedAt !== undefined
              ? old.completedAtEstimated
              : estimated
                ? true
                : undefined,
        outputPreview: polled?.preview ?? old?.outputPreview,
        outputBytes: polled?.bytes ?? old?.outputBytes,
      };
    });

    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
      [sessionId]: keepLiveSubagents(refreshed, existing),
    };
    return restIdle;
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
        void pollTaskOutputForSession(sessionId).then((restIdle) => {
          // The transcript row can settle a beat or two ahead of /tasks: only
          // a REST-confirmed no-running answer may retire the interval, or the
          // lagging answer loses the terminal fetch for good. The user may
          // have switched away while this read was in flight — the stop is
          // global, so it belongs to the session still being polled.
          if (
            restIdle &&
            !activeAppTasks.value.some((t) => t.status === 'running') &&
            rawState.activeSessionId === sessionId &&
            lastPolledSessionId === sessionId
          ) {
            stopTaskOutputPolling();
          }
        });
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
    if (finalBeatTimer !== null) {
      clearTimeout(finalBeatTimer);
      finalBeatTimer = null;
      finalBeatSessionId = undefined;
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
  // The closing beat for the no-running case: one forced read (it must run
  // even while hidden — the interval skips those ticks), then it reschedules
  // ITSELF until REST confirms no running tasks either. The transcript row
  // can settle a beat or two ahead of /tasks, and stopping on a lagging
  // "running" answer loses the terminal fetch for good (nothing restarts the
  // poller with no running rows left). Module-scope tracking keeps the
  // watcher's re-fires (on every poll's state write) from multiplying it.
  let finalBeatTimer: ReturnType<typeof setTimeout> | null = null;
  let finalBeatSessionId: string | undefined;

  function scheduleFinalBeat(sessionId: string): void {
    if (finalBeatTimer !== null && finalBeatSessionId === sessionId) return;
    // A still-running interval belongs to the PREVIOUS session: its next
    // cross-session tick takes the global-stop branch and would wipe the
    // beat scheduled here. Retire it first — the interval's own
    // cross-session stop is only for the no-beat-follows path.
    if (taskOutputPollTimer !== null && lastPolledSessionId !== sessionId) {
      stopTaskOutputPolling();
    }
    if (finalBeatTimer !== null) clearTimeout(finalBeatTimer);
    finalBeatSessionId = sessionId;
    let beats = 0;
    const beat = (): void => {
      void pollTaskOutputForSession(sessionId).then((restIdle) => {
        if (finalBeatSessionId !== sessionId) return;
        if (activeAppTasks.value.some((t) => t.status === 'running')) {
          // New work appeared meanwhile — the running branch owns polling now.
          if (finalBeatTimer !== null) clearTimeout(finalBeatTimer);
          finalBeatTimer = null;
          finalBeatSessionId = undefined;
          return;
        }
        if (restIdle) {
          if (finalBeatTimer !== null) clearTimeout(finalBeatTimer);
          finalBeatTimer = null;
          finalBeatSessionId = undefined;
          if (lastPolledSessionId === sessionId) stopTaskOutputPolling();
          return;
        }
        beats += 1;
        if (beats >= 10) {
          // REST never confirmed: the transcript row already settled the UI —
          // stop rather than poll forever.
          if (finalBeatTimer !== null) clearTimeout(finalBeatTimer);
          finalBeatTimer = null;
          finalBeatSessionId = undefined;
          if (lastPolledSessionId === sessionId) stopTaskOutputPolling();
          return;
        }
        finalBeatTimer = setTimeout(beat, 1500);
      });
    };
    finalBeatTimer = setTimeout(beat, 1500);
  }

  const pollGate = computed(() => {
    const sid = rawState.activeSessionId;
    if (!sid) return { sid: undefined as string | undefined, hasRunning: false };
    // Gate on the VISIBLE rows (transcript flow), not rawState.tasksBySession:
    // the legacy slice is only refreshed by this very poll, so a task spawned
    // after the session was opened would never start polling otherwise.
    return { sid, hasRunning: activeAppTasks.value.some((t) => t.status === 'running') };
  });

  watch(
    pollGate,
    ({ sid, hasRunning }) => {
      if (hasRunning && sid !== undefined) {
        // New work cycle: a pending closing beat from the finished round is moot.
        if (finalBeatTimer !== null) {
          clearTimeout(finalBeatTimer);
          finalBeatTimer = null;
          finalBeatSessionId = undefined;
        }
        startTaskOutputPolling(sid);
      } else if (sid !== undefined) {
        scheduleFinalBeat(sid);
      } else {
        stopTaskOutputPolling();
      }
    },
    { immediate: true },
  );

  return {
    taskClock: computed(() => taskClock.value),
    loadTasksForSession,
  };
}
