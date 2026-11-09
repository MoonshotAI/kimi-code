import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    listeners,
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    }),
    emit: (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
    getAllKimiSessions: vi.fn(),
    loadSessionHistory: vi.fn(),
    setWorkDir: vi.fn(),
    deleteSession: vi.fn(),
    openNewSessionTab: vi.fn(),
    abortChat: vi.fn(),
    resetSession: vi.fn(),
    clearTrackedFiles: vi.fn(),
    streamChat: vi.fn(),
  };
});

vi.mock("@/services", () => ({
  bridge,
  Events: { FocusInput: "focusInput", InsertMention: "insertMention" },
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { SessionList } from "@/components/SessionList";
import { useChatStore } from "@/stores/chat.store";
import { useSettingsStore } from "@/stores/settings.store";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.listeners.clear();
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-11-09T10:00:00Z").valueOf());
  bridge.getAllKimiSessions.mockResolvedValue([
    {
      id: "older",
      workDir: "/workspace/packages/api",
      updatedAt: Date.now() - 60 * 60 * 1000,
      brief: "Older API chat",
      isRunning: false,
      status: "completed",
      latestActivity: "Finished",
      branch: "main",
    },
    {
      id: "waiting",
      workDir: "/workspace",
      updatedAt: Date.now() - 30 * 60 * 1000,
      brief: "Waiting for approval chat",
      isRunning: true,
      status: "waiting",
      latestActivity: "Waiting for approval",
      startedAt: Date.now() - 10 * 60 * 1000,
      branch: "feat/review",
    },
    {
      id: "current",
      workDir: "/workspace",
      updatedAt: Date.now() - 5 * 60 * 1000,
      brief: "Current running chat",
      isRunning: true,
      status: "running",
      latestActivity: "Running Shell",
      startedAt: Date.now() - 2 * 60 * 1000,
      branch: "feat/sessions",
    },
  ]);
  bridge.loadSessionHistory.mockResolvedValue([]);
  bridge.setWorkDir.mockResolvedValue({ ok: true, workDir: "/workspace" });
  bridge.deleteSession.mockResolvedValue({ ok: true });
  bridge.openNewSessionTab.mockResolvedValue({ ok: true });
  bridge.resetSession.mockResolvedValue({ ok: true });
  bridge.clearTrackedFiles.mockResolvedValue({ ok: true });
  bridge.streamChat.mockResolvedValue({ ok: true });
  useChatStore.setState({
    sessionId: "current",
    messages: [],
    isStreaming: true,
    pendingQuestion: null,
    queue: [],
  });
  useSettingsStore.setState({
    workspaceRoot: "/workspace",
    currentWorkDir: null,
    currentModel: "kimi-k3",
    thinkingEffort: undefined,
    extensionConfig: {
      ...useSettingsStore.getState().extensionConfig,
      useCtrlEnterToSend: false,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conversation history", () => {
  it("shows newest sessions first with running, age, and directory metadata", async () => {
    render(<SessionList onClose={vi.fn()} />, { wrapper });

    const current = await screen.findByText("Current running chat");
    const older = screen.getByText("Older API chat");
    expect(screen.queryByText("Running")).not.toBeNull();
    expect(screen.queryByText("5m ago")).not.toBeNull();
    expect(screen.queryByText("1h ago")).not.toBeNull();
    expect(screen.queryByText("· ./packages/api")).not.toBeNull();
    expect(screen.queryByText("Running Shell")).not.toBeNull();
    expect(screen.queryByText("feat/sessions")).not.toBeNull();
    expect(screen.queryByText("2m")).not.toBeNull();
    expect(screen.queryByText("Waiting")).not.toBeNull();
    expect(screen.queryByText("Waiting for approval")).not.toBeNull();

    const currentRow = current.closest('[role="button"]');
    const olderRow = older.closest('[role="button"]');
    expect(currentRow).not.toBeNull();
    expect(olderRow).not.toBeNull();
    expect(currentRow!.compareDocumentPosition(olderRow!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("returns to the current running chat without stopping or reloading it", async () => {
    const onClose = vi.fn();
    render(<SessionList onClose={onClose} />, { wrapper });

    fireEvent.click(await screen.findByText("Current running chat"));

    expect(onClose).toHaveBeenCalledOnce();
    expect(bridge.abortChat).not.toHaveBeenCalled();
    expect(bridge.loadSessionHistory).not.toHaveBeenCalled();
  });

  it("filters conversations by title", async () => {
    const user = userEvent.setup();
    render(<SessionList onClose={vi.fn()} />, { wrapper });
    await screen.findByText("Current running chat");

    await user.type(screen.getByPlaceholderText("Search conversations…"), "api");

    await waitFor(() => expect(screen.queryByText("Current running chat")).toBeNull());
    expect(screen.queryByText("Older API chat")).not.toBeNull();
  });

  it("opens a saved conversation in a new panel without switching the current chat", async () => {
    const user = userEvent.setup();
    render(<SessionList onClose={vi.fn()} />, { wrapper });
    await screen.findByText("Older API chat");

    await user.click(screen.getByRole("button", { name: "Conversation actions for Older API chat" }));
    await user.click(await screen.findByText("Open in new window"));

    expect(bridge.openNewSessionTab).toHaveBeenCalledWith({
      sessionId: "older",
      workDir: "/workspace/packages/api",
    });
    expect(useChatStore.getState().sessionId).toBe("current");
    expect(bridge.abortChat).not.toHaveBeenCalled();
    expect(bridge.loadSessionHistory).not.toHaveBeenCalled();
  });

  it("starts and opens a new conversation from the home composer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useChatStore.setState({ isStreaming: false });
    render(<SessionList onClose={onClose} />, { wrapper });

    await user.type(screen.getByRole("textbox", { name: "New conversation message" }), "Investigate the failing tests");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(bridge.streamChat).toHaveBeenCalled());
    expect(bridge.resetSession).toHaveBeenCalledOnce();
    expect(bridge.clearTrackedFiles).toHaveBeenCalledOnce();
    expect(bridge.streamChat.mock.calls[0]?.[0]).toBe("Investigate the failing tests");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes focus and editor mentions to the visible home composer", () => {
    render(<SessionList onClose={vi.fn()} />, { wrapper });
    const input = screen.getByRole("textbox", { name: "New conversation message" }) as HTMLTextAreaElement;

    act(() => bridge.emit("insertMention", { mention: "@src/example.ts" }));
    expect(input.value).toBe("@src/example.ts ");

    act(() => bridge.emit("focusInput", {}));
    expect(document.activeElement).toBe(input);
  });

  it("confirms before the home composer replaces a streaming conversation", async () => {
    const user = userEvent.setup();
    render(<SessionList onClose={vi.fn()} />, { wrapper });

    await user.type(screen.getByRole("textbox", { name: "New conversation message" }), "Start another task");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Start New Conversation?")).not.toBeNull();
    expect(bridge.resetSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start Conversation" }));
    await waitFor(() => expect(bridge.streamChat).toHaveBeenCalled());
    expect(bridge.abortChat).toHaveBeenCalledOnce();
    expect(bridge.streamChat.mock.calls[0]?.[0]).toBe("Start another task");
  });
});
