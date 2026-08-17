// @vitest-environment jsdom
/**
 * Scenario: background task state in the VS Code Webview across session restoration and output refreshes.
 * Responsibilities: restored task announcements survive history replay, and a successful output refresh replaces a transient error.
 * Wiring: the real Zustand stores and TasksModal are used; only the VS Code bridge process boundary is mocked.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/background-tasks-ui.test.ts
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundTaskInfo } from "../shared/legacy-sdk";
import { TasksModal } from "../webview-ui/src/components/TasksModal";
import { useChatStore } from "../webview-ui/src/stores/chat.store";
import { useTasksStore } from "../webview-ui/src/stores/tasks.store";

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    getBackgroundTaskOutput: vi.fn(),
    listBackgroundTasks: vi.fn(),
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  bridgeMock.getBackgroundTaskOutput.mockReset();
  bridgeMock.listBackgroundTasks.mockReset();
  bridgeMock.stopBackgroundTask.mockReset();
  useChatStore.setState({ isStreaming: false });
  useTasksStore.setState({ tasks: [], browserOpen: false });
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("background task Webview state (restores task lists and output)", () => {
  it("preserves announced tasks when session history finishes loading", async () => {
    useTasksStore.getState().setTasks([runningTask]);

    await useChatStore.getState().loadSession("session-2", []);

    expect(useTasksStore.getState().tasks).toEqual([runningTask]);
  });

  it("shows recovered output when a successful refresh follows a transient error", async () => {
    bridgeMock.listBackgroundTasks.mockResolvedValue([runningTask]);
    bridgeMock.getBackgroundTaskOutput
      .mockRejectedValueOnce(new Error("temporary output failure"))
      .mockResolvedValueOnce({ output: "server ready" });
    useTasksStore.setState({ tasks: [runningTask], browserOpen: true });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(TasksModal)));
    const expandButton = container.querySelector<HTMLButtonElement>('button[title="View output"]');
    expect(expandButton).not.toBeNull();
    await act(async () => expandButton?.click());
    expect(container.textContent).toContain("temporary output failure");

    await act(async () => {
      useTasksStore.getState().setTasks([
        { ...runningTask, status: "completed", exitCode: 0, endedAt: 2000 },
      ]);
    });

    expect(container.textContent).toContain("server ready");
    expect(container.textContent).not.toContain("temporary output failure");
  });
});
