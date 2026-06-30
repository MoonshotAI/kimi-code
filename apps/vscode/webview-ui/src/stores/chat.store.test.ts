import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialDisplayState } from "@moonshot-ai/kimi-code-vscode-display-model";
import type { UIStreamEvent } from "shared/types";

import { bridge } from "@/services";
import { useChatStore } from "./chat.store";

vi.mock("@/services", () => ({
  bridge: {
    streamChat: vi.fn(),
    abortChat: vi.fn(),
    steerChat: vi.fn(),
    resetSession: vi.fn(),
    trackFiles: vi.fn(),
    clearTrackedFiles: vi.fn(),
    respondApproval: vi.fn(),
  },
}));

function resetChatStore(): void {
  useChatStore.setState({
    sessionId: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    handshakeReceived: false,
    draftMedia: [],
    pendingInput: null,
    queuedInputs: [],
    displayState: createInitialDisplayState(),
    pendingOptimisticTurn: null,
  });
}

describe("chat.store shared display projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.streamChat).mockResolvedValue({ done: true });
    resetChatStore();
  });

  it("finalizes display state for history replay without terminal events", () => {
    const events: UIStreamEvent[] = [
      { type: "TurnBegin", payload: { user_input: "hello" } },
      { type: "ContentPart", payload: { type: "text", text: "world" } },
    ];

    useChatStore.getState().loadSession("session-1", events);

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.displayState.isStreaming).toBe(false);
    expect(state.displayState.messages[1]?.status).toBe("completed");
    expect(state.displayState.messages[1]?.steps?.[0]?.parts).toEqual([{ type: "text", text: "world", finished: true }]);
  });

  it("preserves media-bearing user input in shared display history", () => {
    useChatStore.getState().loadSession("session-media", [
      {
        type: "TurnBegin",
        payload: {
          user_input: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc", id: "img-1" } },
          ],
        },
      },
    ]);

    expect(useChatStore.getState().displayState.messages[0]?.parts).toEqual([
      { type: "text", text: "look" },
      { type: "media", kind: "image", url: "data:image/png;base64,abc", id: "img-1" },
    ]);
  });

  it("optimistically renders user and assistant placeholder immediately when sending", () => {
    useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(bridge.streamChat).toHaveBeenCalledWith("hello", "", false, "default", undefined);
    expect(state.pendingOptimisticTurn?.content).toBe("hello");
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1]?.steps).toEqual([]);
    expect(state.displayState.messages.map((message) => `${message.role}:${message.status}`)).toEqual(["user:completed", "assistant:streaming"]);
    expect(state.displayState.isStreaming).toBe(true);
  });

  it("deduplicates the matching TurnBegin after optimistic render", () => {
    useChatStore.getState().sendMessage("hello");

    useChatStore.getState().processEvent({ type: "TurnBegin", payload: { user_input: "hello" } });

    const state = useChatStore.getState();
    expect(state.pendingOptimisticTurn).toBeNull();
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(state.displayState.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("rolls back optimistic placeholders on preflight error", () => {
    useChatStore.getState().sendMessage("hello");

    useChatStore.getState().processEvent({
      type: "error",
      code: "NO_WORKSPACE",
      message: "Please open a folder to start.",
      phase: "preflight",
    });

    const state = useChatStore.getState();
    expect(state.pendingOptimisticTurn).toBeNull();
    expect(state.pendingInput?.content).toBe("hello");
    expect(state.messages).toEqual([]);
    expect(state.displayState.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
  });

  it("optimistically renders media-bearing prompts and keeps the original content for dedupe", () => {
    useChatStore.getState().sendMessage("look", ["data:image/png;base64,abc"]);

    const state = useChatStore.getState();
    expect(state.pendingOptimisticTurn?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
    expect(state.displayState.messages[0]?.parts).toEqual([
      { type: "text", text: "look" },
      { type: "media", kind: "image", url: "data:image/png;base64,abc", id: undefined },
    ]);
  });

  it("starts a new conversation immediately without waiting for bridge cleanup", () => {
    vi.mocked(bridge.resetSession).mockReturnValue(new Promise(() => undefined));
    vi.mocked(bridge.clearTrackedFiles).mockReturnValue(new Promise(() => undefined));
    useChatStore.setState({
      sessionId: "old-session",
      messages: [{ id: "old", role: "user", content: "old", timestamp: 1 }],
      isStreaming: true,
      displayState: {
        ...createInitialDisplayState(),
        messages: [{ id: "old-display", role: "user", parts: [{ type: "text", text: "old" }], status: "completed", createdAt: 1 }],
      },
      pendingOptimisticTurn: { id: "old-turn", content: "old", createdAt: 1 },
    });

    void useChatStore.getState().startNewConversation();

    const state = useChatStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.displayState.messages).toEqual([]);
    expect(state.pendingOptimisticTurn).toBeNull();
    expect(bridge.clearTrackedFiles).toHaveBeenCalled();
    expect(bridge.resetSession).toHaveBeenCalled();
  });

  it("responds to approvals through the shared pending approval projection", async () => {
    useChatStore.setState({
      displayState: {
        ...createInitialDisplayState(),
        pendingApprovals: [
          {
            type: "approval",
            requestId: 0,
            toolCallId: "tool-1",
            sender: "agent",
            action: "Shell",
            description: "Run command",
          },
        ],
      },
    });
    vi.mocked(bridge.respondApproval).mockResolvedValue({ ok: true });

    await useChatStore.getState().respondApproval(0, "approve");

    expect(bridge.respondApproval).toHaveBeenCalledWith(0, "approve");
    expect(useChatStore.getState().displayState.pendingApprovals).toEqual([]);
  });
});
