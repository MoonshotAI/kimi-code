import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  getAllKimiSessions: vi.fn(),
  loadSessionHistory: vi.fn(),
  setWorkDir: vi.fn(),
  deleteSession: vi.fn(),
  openNewSessionTab: vi.fn(),
  abortChat: vi.fn(),
  resetSession: vi.fn(),
  clearTrackedFiles: vi.fn(),
}));

vi.mock("@/services", () => ({ bridge }));
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
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-11-09T10:00:00Z").valueOf());
  bridge.getAllKimiSessions.mockResolvedValue([
    {
      id: "older",
      workDir: "/workspace/packages/api",
      updatedAt: Date.now() - 60 * 60 * 1000,
      brief: "Older API chat",
      isRunning: false,
    },
    {
      id: "current",
      workDir: "/workspace",
      updatedAt: Date.now() - 5 * 60 * 1000,
      brief: "Current running chat",
      isRunning: true,
    },
  ]);
  bridge.loadSessionHistory.mockResolvedValue([]);
  bridge.setWorkDir.mockResolvedValue({ ok: true, workDir: "/workspace" });
  bridge.deleteSession.mockResolvedValue({ ok: true });
  bridge.openNewSessionTab.mockResolvedValue({ ok: true });
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
});
