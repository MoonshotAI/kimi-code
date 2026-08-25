// Scenario: terminal-output backfill for background tasks (useTaskPoller).
// Responsibilities: folded background-subagent rows must receive the output
// fetched under their REST task id, and a transient getTask failure must not
// permanently suppress later backfills.
// Wiring: the composable is real; daemon requests are stubbed.
// Run: pnpm --filter @moonshot-ai/app-client exec vitest run test/task-poller.test.ts

import { computed, reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTask, KimiWebApi } from '@moonshot-ai/app-core/api';
import { createInitialState } from '@moonshot-ai/app-core/api';
import { useTaskPoller } from '../src/client/useTaskPoller';
import type { ExtendedState } from '../src/client/types';

// The api is injected; stub the task endpoints.
const apiMock = {
  listTasks: vi.fn(),
  getTask: vi.fn(),
};
const api = apiMock as unknown as KimiWebApi;

function createState(tasks: AppTask[]): ExtendedState {
  return {
    ...createInitialState(),
    activeSessionId: 'sess_1',
    tasksBySession: { sess_1: tasks },
  } as unknown as ExtendedState;
}

function subagent(id: string, overrides: Partial<AppTask> = {}): AppTask {
  return {
    id,
    sessionId: 'sess_1',
    kind: 'subagent',
    description: `task ${id}`,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The same background subagent as seen on the two channels: WS keys it by
    agent id, REST by background-task id (`backgroundTaskId` links them).
    The live row is already completed so the poller's 1s output polling does
    not start racing the one-off backfill under test. */
function liveRow(): AppTask {
  return subagent('agent-1', {
    runInBackground: true,
    backgroundTaskId: 'task-9',
    status: 'completed',
    completedAt: '2026-01-01T00:01:00.000Z',
  });
}
function restRow(overrides: Partial<AppTask> = {}): AppTask {
  return subagent('task-9', {
    runInBackground: true,
    status: 'completed',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  });
}

describe('useTaskPoller terminal-output backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forces one final poll before stopping so a task terminal while hidden still gets its final output', async () => {
    // The interval skips its ticks while the page is hidden; without the
    // forced last poll the 1.5s stop timer would shut polling down before any
    // final-output fetch ran, and restoring the tab never restarts it.
    vi.useFakeTimers();
    try {
      const running = subagent('task-1', { status: 'running' });
      const terminal = { ...running, status: 'completed' as const, completedAt: '2026-01-01T00:01:00.000Z' };
      const state = reactive(createState([running]));
      let terminalNow = false;
      apiMock.listTasks.mockImplementation(async () => [terminalNow ? terminal : running]);
      apiMock.getTask.mockImplementation(async (sid: string, id: string, opts: unknown) => {
        console.log('DBG getTask:', sid, id, JSON.stringify(opts));
        return {
          ...terminal,
          outputPreview: 'final result',
          outputBytes: 2048,
        };
      });
      vi.stubGlobal('document', { visibilityState: 'hidden' });

      useTaskPoller(state, computed(() => state.tasksBySession['sess_1'] ?? []), { api });
      // Let the construction poll settle first, or its write lands after the
      // flip and the stop timer's no-running guard rejects the forced poll.
      await vi.advanceTimersByTimeAsync(0);
      // The task goes terminal (via transcript) while the page is hidden.
      terminalNow = true;
      state.tasksBySession = { sess_1: [terminal] };

      // The 1.5s stop timer must run one last poll (listTasks + the
      // final-bytes getTask) before shutting polling down.
      await vi.advanceTimersByTimeAsync(1600);
      expect(apiMock.getTask).toHaveBeenCalledWith(
        'sess_1',
        'task-1',
        expect.objectContaining({ withOutput: true, outputBytes: 32 * 1024 }),
      );
      expect(state.tasksBySession['sess_1']?.[0]?.outputPreview).toBe('final result');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('does not let an in-flight final poll from session A stop session B\'s polling', async () => {
    // A's 1.5s final poll is in flight when the user switches to B (which has
    // running tasks and starts its own interval): A's finally must not call
    // the global stop — only the session currently being polled may be stopped.
    vi.useFakeTimers();
    try {
      const aRunning = subagent('task-a', { status: 'running' });
      const aTerminal = { ...aRunning, status: 'completed' as const, completedAt: '2026-01-01T00:01:00.000Z' };
      const bRunning = subagent('task-b', { id: 'task-b', status: 'running' });
      const state = reactive(createState([aRunning]));
      let aTerminalNow = false;
      apiMock.listTasks.mockImplementation(async (sid: string) => {
        if (sid === 'sess_2') return [bRunning];
        return [aTerminalNow ? aTerminal : aRunning];
      });
      let resolveA!: (value: unknown) => void;
      apiMock.getTask.mockImplementation(async (sid: string) => {
        if (sid === 'sess_1') {
          return new Promise((resolve) => { resolveA = resolve; });
        }
        return bRunning;
      });
      useTaskPoller(state, computed(() => state.tasksBySession[state.activeSessionId ?? ''] ?? []), { api });
      await vi.advanceTimersByTimeAsync(0);

      // A goes terminal (via transcript) while hidden → the 1.5s timer arms,
      // and its forced final poll blocks on the deferred getTask.
      aTerminalNow = true;
      state.tasksBySession = { ...state.tasksBySession, sess_1: [aTerminal] };
      await vi.advanceTimersByTimeAsync(1600);
      expect(apiMock.getTask).toHaveBeenCalledWith('sess_1', 'task-a', expect.anything());

      // Switch to B (running) before A's final poll resolves.
      state.sessions.push({ ...state.sessions[0]!, id: 'sess_2' });
      state.activeSessionId = 'sess_2';
      state.tasksBySession = { ...state.tasksBySession, sess_2: [bRunning] };
      await vi.advanceTimersByTimeAsync(0);

      // A's final poll lands — its stop must NOT kill B's interval.
      resolveA({ ...aTerminal, outputPreview: 'done', outputBytes: 128 });
      await vi.advanceTimersByTimeAsync(0);
      const listCallsForB = () =>
        apiMock.listTasks.mock.calls.filter(([sid]) => sid === 'sess_2').length;
      const before = listCallsForB();
      await vi.advanceTimersByTimeAsync(1200);
      expect(listCallsForB()).toBeGreaterThan(before);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('attaches output fetched under the REST id to the folded agent-id row', async () => {
    const state = createState([liveRow()]);
    apiMock.listTasks.mockResolvedValue([restRow()]);
    apiMock.getTask.mockResolvedValue(
      restRow({ outputPreview: 'final result', outputBytes: 2048 }),
    );

    const poller = useTaskPoller(state, computed(() => []), { api });
    await poller.loadTasksForSession('sess_1');

    expect(apiMock.getTask).toHaveBeenCalledWith(
      'sess_1',
      'task-9',
      expect.objectContaining({ withOutput: true }),
    );
    const rows = state.tasksBySession['sess_1'] ?? [];
    expect(rows.map((t) => t.id)).toEqual(['agent-1']);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.outputPreview).toBe('final result');
    expect(rows[0]?.outputBytes).toBe(2048);
  });

  it('fetches terminal output only once for a task', async () => {
    const state = createState([liveRow()]);
    apiMock.listTasks.mockResolvedValue([restRow()]);
    apiMock.getTask.mockResolvedValue(
      restRow({ outputPreview: 'final result', outputBytes: 2048 }),
    );

    const poller = useTaskPoller(state, computed(() => []), { api });
    await poller.loadTasksForSession('sess_1');
    await poller.loadTasksForSession('sess_1');

    expect(apiMock.getTask).toHaveBeenCalledTimes(1);
  });

  it('retries the backfill on a later load after a transient getTask failure', async () => {
    const state = createState([liveRow()]);
    apiMock.listTasks.mockResolvedValue([restRow()]);
    apiMock.getTask
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue(restRow({ outputPreview: 'final result', outputBytes: 2048 }));

    const poller = useTaskPoller(state, computed(() => []), { api });
    await poller.loadTasksForSession('sess_1');
    expect(state.tasksBySession['sess_1']?.[0]?.outputPreview).toBeUndefined();

    await poller.loadTasksForSession('sess_1');
    expect(apiMock.getTask).toHaveBeenCalledTimes(2);
    expect(state.tasksBySession['sess_1']?.[0]?.outputPreview).toBe('final result');
  });
});

describe('useTaskPoller final-beat REST confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the final beats polling until REST confirms the terminal state', async () => {
    // The transcript row already settled (no running rows) but /tasks still
    // says running: stopping on the first lagging answer would lose the
    // terminal fetch forever — the beat must reschedule until REST agrees.
    vi.useFakeTimers();
    try {
      const terminal = subagent('task-1', {
        status: 'completed',
        completedAt: '2026-01-01T00:01:00.000Z',
      });
      const running = { ...terminal, status: 'running' as const, completedAt: undefined };
      // Isolate from earlier tests' still-live pollers (their real-clock
      // beats share this mock): only calls for THIS session count.
      const state = reactive({
        ...createInitialState(),
        activeSessionId: 'sess_beat',
        tasksBySession: { sess_beat: [terminal] },
      } as unknown as ExtendedState);
      let restCalls = 0;
      apiMock.listTasks.mockImplementation(async (sid: string) => {
        if (sid !== 'sess_beat') return [];
        restCalls += 1;
        // REST lags two beats behind the transcript's terminal row.
        return [restCalls <= 2 ? running : terminal];
      });
      apiMock.getTask.mockResolvedValue({
        ...terminal,
        outputPreview: 'final result',
        outputBytes: 2048,
      });
      // The codex scenario is the user WATCHING: interval ticks keep running
      // (a hidden tab's interval skips ticks by design — the other case).
      vi.stubGlobal('document', { visibilityState: 'visible' });

      useTaskPoller(state, computed(() => state.tasksBySession['sess_beat'] ?? []), { api });
      await vi.advanceTimersByTimeAsync(0);
      apiMock.getTask.mockClear();

      // Beat 1 (+1.5s): REST says running — must NOT stop. The merge makes
      // the row running again, so polling resumes on the 1s interval; the
      // third read confirms terminal → the 32 KiB final fetch lands, and a
      // closing beat then stops polling for real.
      await vi.advanceTimersByTimeAsync(1500);
      // The beat's read plus the immediate read from the resumed interval.
      expect(restCalls).toBe(2);
      // The third read confirms terminal → the 32 KiB final fetch lands.
      await vi.advanceTimersByTimeAsync(4000);
      expect(restCalls).toBeGreaterThanOrEqual(3);
      expect(apiMock.getTask).toHaveBeenCalledWith(
        'sess_beat',
        'task-1',
        expect.objectContaining({ withOutput: true, outputBytes: 32 * 1024 }),
      );
      expect(state.tasksBySession['sess_beat']?.[0]?.outputPreview).toBe('final result');
      const callsAfterConfirm = restCalls;

      // Stopped for real: after the closing beat's confirming read, nothing more.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(restCalls).toBeLessThanOrEqual(callsAfterConfirm + 1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('retires the previous session’s interval when scheduling the closing beat after a switch', async () => {
    // Session A's interval is live when the user switches to session B (no
    // running rows) → B's closing beat is scheduled. A's next tick would take
    // the cross-session global-stop branch and wipe B's fresh timer — the
    // beat's scheduling must retire the foreign interval first.
    vi.useFakeTimers();
    try {
      const runningA = subagent('task-a1', { status: 'running', sessionId: 'sess_a' });
      const state = reactive({
        ...createInitialState(),
        activeSessionId: 'sess_a',
        tasksBySession: { sess_a: [runningA], sess_b: [] },
      } as unknown as ExtendedState);
      apiMock.listTasks.mockImplementation(async (sid: string) =>
        sid === 'sess_a' ? [runningA] : [],
      );
      vi.stubGlobal('document', { visibilityState: 'visible' });

      // The visible rows follow the ACTIVE session (the App wires it so).
      useTaskPoller(
        state,
        computed(() => state.tasksBySession[state.activeSessionId ?? ''] ?? []),
        { api },
      );
      await vi.advanceTimersByTimeAsync(0);
      apiMock.listTasks.mockClear();

      // Switch to B: no running rows → B's closing beat is scheduled (1.5s).
      state.activeSessionId = 'sess_b';
      await vi.advanceTimersByTimeAsync(0);

      // Past A's 1s interval tick AND B's 1.5s beat: B's beat must still fire
      // its forced read — A's retired interval can't wipe it anymore.
      await vi.advanceTimersByTimeAsync(1600);
      expect(apiMock.listTasks).toHaveBeenCalledWith('sess_b');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
