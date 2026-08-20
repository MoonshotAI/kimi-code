// @vitest-environment jsdom
/**
 * Scenario: background task state in the VS Code Webview across session restoration and output refreshes.
 * Responsibilities: task state stays session-scoped and monotonic while sessions restore and output refreshes recover.
 * Wiring: the real Zustand stores and TasksModal are used; only the VS Code bridge process boundary is mocked.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/background-tasks-ui.test.ts
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundTaskInfo } from "../shared/legacy-sdk";
import type { BackgroundTasksChangedPayload, UIStreamEvent } from "../shared/types";
import { TasksModal } from "../webview-ui/src/components/TasksModal";
import { useChatStore } from "../webview-ui/src/stores/chat.store";
import { useTasksStore } from "../webview-ui/src/stores/tasks.store";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    getBackgroundTaskOutput: vi.fn(),
    listBackgroundTasks: vi.fn(),
    loadSessionHistory: vi.fn(),
    stopBackgroundTask: vi.fn(),
  },
}));

vi.mock("@/services", () => ({ bridge: bridgeMock }));

const runningTask: BackgroundTaskInfo = {
  taskId: "bash-1",
  kind: "process",
  description: "dev server",
  status: "running",
  command: "pnpm dev",
  pid: 1234,
  exitCode: null,
  startedAt: 1000,
  endedAt: null,
};

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  bridgeMock.getBackgroundTaskOutput.mockReset();
  bridgeMock.listBackgroundTasks.mockReset();
  bridgeMock.loadSessionHistory.mockReset();
  bridgeMock.stopBackgroundTask.mockReset();
  useChatStore.setState({ sessionId: null, messages: [], isStreaming: false });
  useTasksStore.getState().setSession(null);
  useTasksStore.getState().setBrowserOpen(false);
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

describe("background task Webview state (restores task lists and output)", () => {
  it("preserves announced tasks when session history finishes loading", async () => {
    useTasksStore.getState().setSession("session-2");
    useTasksStore.getState().applySnapshot({ sessionId: "session-2", tasks: [runningTask] });

    await useChatStore.getState().loadSession("session-2", []);

    expect(useTasksStore.getState().tasks).toEqual([runningTask]);
  });

  it("ignores task notifications when they belong to another session", () => {
    const currentTask = { ...runningTask, taskId: "bash-current" };
    useTasksStore.getState().setSession("session-current");
    useTasksStore.getState().applySnapshot({
      sessionId: "session-current",
      tasks: [currentTask],
    });

    useTasksStore.getState().applySnapshot({
      sessionId: "session-other",
      tasks: [runningTask],
    });

    expect(useTasksStore.getState().tasks).toEqual([currentTask]);
  });

  it("discards a refresh response when a newer lifecycle snapshot arrives", async () => {
    let resolveRefresh!: (snapshot: BackgroundTasksChangedPayload) => void;
    bridgeMock.listBackgroundTasks.mockReturnValue(
      new Promise<BackgroundTasksChangedPayload>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    useTasksStore.getState().setSession("session-1");
    useTasksStore.getState().applySnapshot({ sessionId: "session-1", tasks: [runningTask] });
    const refresh = useTasksStore.getState().refreshTasks();
    const completedTask: BackgroundTaskInfo = {
      ...runningTask,
      status: "completed",
      exitCode: 0,
      endedAt: 2000,
    };
    useTasksStore.getState().applySnapshot({
      sessionId: "session-1",
      tasks: [completedTask],
    });

    resolveRefresh({ sessionId: "session-1", tasks: [runningTask] });
    await refresh;

    expect(useTasksStore.getState().tasks).toEqual([completedTask]);
  });

  it("commits only the latest session when history responses complete later", async () => {
    let resolveFirst!: (events: UIStreamEvent[]) => void;
    let activeHostSession: string | null = null;
    const firstHistory = new Promise<UIStreamEvent[]>((resolve) => {
      resolveFirst = resolve;
    });
    bridgeMock.loadSessionHistory
      .mockImplementationOnce((sessionId: string) => {
        return firstHistory.then((events) => {
          activeHostSession = sessionId;
          return events;
        });
      })
      .mockImplementationOnce(async (sessionId: string) => {
        activeHostSession = sessionId;
        return [];
      });

    const first = useChatStore.getState().restoreSession("session-1");
    await Promise.resolve();
    const second = useChatStore.getState().restoreSession("session-2");
    resolveFirst([]);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(useChatStore.getState().sessionId).toBe("session-2");
    expect(useTasksStore.getState().sessionId).toBe("session-2");
    expect(activeHostSession).toBe("session-2");
  });

  it("restores the committed task session when history loading fails", async () => {
    const committedTask = { ...runningTask, taskId: "bash-committed" };
    await useChatStore.getState().loadSession("session-committed", []);
    useTasksStore.getState().applySnapshot({
      sessionId: "session-committed",
      tasks: [committedTask],
    });
    bridgeMock.loadSessionHistory.mockRejectedValue(new Error("history unavailable"));
    bridgeMock.listBackgroundTasks.mockResolvedValue({
      sessionId: "session-committed",
      tasks: [committedTask],
    });

    await expect(
      useChatStore.getState().restoreSession("session-unavailable"),
    ).rejects.toThrow("history unavailable");

    expect(useChatStore.getState().sessionId).toBe("session-committed");
    expect(useTasksStore.getState().sessionId).toBe("session-committed");
    expect(useTasksStore.getState().tasks).toEqual([committedTask]);
  });

  it("shows recovered output when a successful refresh follows a transient error", async () => {
    bridgeMock.listBackgroundTasks.mockResolvedValue({
      sessionId: "session-1",
      tasks: [runningTask],
    });
    bridgeMock.getBackgroundTaskOutput
      .mockRejectedValueOnce(new Error("temporary output failure"))
      .mockResolvedValueOnce({ output: "server ready" });
    useTasksStore.getState().setSession("session-1");
    useTasksStore.getState().applySnapshot({ sessionId: "session-1", tasks: [runningTask] });
    useTasksStore.setState({ browserOpen: true });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(TasksModal)));
    const expandButton = container.querySelector<HTMLButtonElement>('button[title="View output"]');
    expect(expandButton).not.toBeNull();
    await act(async () => expandButton?.click());
    expect(container.textContent).toContain("temporary output failure");

    await act(async () => {
      useTasksStore.getState().applySnapshot({
        sessionId: "session-1",
        tasks: [{ ...runningTask, status: "completed", exitCode: 0, endedAt: 2000 }],
      });
    });

    expect(container.textContent).toContain("server ready");
    expect(container.textContent).not.toContain("temporary output failure");
  });
});
