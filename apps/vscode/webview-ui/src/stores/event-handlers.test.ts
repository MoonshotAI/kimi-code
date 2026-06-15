import { describe, expect, it, vi } from "vitest";

import { processEvent } from "./event-handlers";
import { createInitialDisplayState } from "@moonshot-ai/kimi-code-vscode-display-model";
import type { ChatMessage, ChatState, UIStepItem } from "./chat.store";

vi.mock("@/services", () => ({
  bridge: {
    trackFiles: vi.fn(),
  },
}));

function createDraft(): ChatState {
  return {
    sessionId: null,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: 0,
        steps: [],
      },
    ],
    isStreaming: true,
    isCompacting: false,
    handshakeReceived: true,
    draftMedia: [],
    pendingInput: null,
    queuedInputs: [],
    displayState: createInitialDisplayState(),
    pendingOptimisticTurn: null,
    sendMessage: vi.fn(),
    clearQueuedInputs: vi.fn(),
    respondApproval: vi.fn(),
    updateQueuedInput: vi.fn(),
    removeQueuedInput: vi.fn(),
    moveQueuedInput: vi.fn(),
    steerQueuedInput: vi.fn(),
    steerAllQueuedInputs: vi.fn(),
    retryLastMessage: vi.fn(),
    processEvent: vi.fn(),
    loadSession: vi.fn(),
    startNewConversation: vi.fn(),
    abort: vi.fn(),
    addDraftMedia: vi.fn(),
    updateDraftMedia: vi.fn(),
    removeDraftMedia: vi.fn(),
    clearDraftMedia: vi.fn(),
    hasProcessingMedia: vi.fn(() => false),
    rollbackInput: vi.fn(),
  };
}

function assistant(draft: ChatState): ChatMessage {
  const message = draft.messages[0];
  if (message === undefined || message.role !== "assistant") {
    throw new Error("missing assistant message");
  }
  return message;
}

function items(draft: ChatState): UIStepItem[] {
  return assistant(draft).steps?.[0]?.items ?? [];
}

function toolCall(id: string, name: string) {
  return {
    type: "ToolCall" as const,
    payload: {
      id,
      type: "function" as const,
      function: {
        name,
        arguments: "{}",
      },
    },
  };
}

describe("processEvent step item ordering", () => {
  it("keeps thinking blocks in event order around tool calls", () => {
    const draft = createDraft();

    processEvent(draft, { type: "StepBegin", payload: { n: 1 } });
    processEvent(draft, { type: "ContentPart", payload: { type: "think", think: "A" } });
    processEvent(draft, toolCall("tool-1", "Read"));
    processEvent(draft, { type: "ContentPart", payload: { type: "think", think: "B" } });
    processEvent(draft, toolCall("tool-2", "Grep"));
    processEvent(draft, { type: "ContentPart", payload: { type: "text", text: "Done" } });

    expect(items(draft)).toMatchObject([
      { type: "thinking", content: "A", finished: true },
      { type: "tool_use", id: "tool-1" },
      { type: "thinking", content: "B", finished: true },
      { type: "tool_use", id: "tool-2" },
      { type: "text", content: "Done" },
    ]);
  });

  it("only coalesces adjacent active thinking chunks", () => {
    const draft = createDraft();

    processEvent(draft, { type: "StepBegin", payload: { n: 1 } });
    processEvent(draft, { type: "ContentPart", payload: { type: "think", think: "A" } });
    processEvent(draft, { type: "ContentPart", payload: { type: "think", think: "B" } });
    processEvent(draft, toolCall("tool-1", "Read"));
    processEvent(draft, { type: "ContentPart", payload: { type: "think", think: "C" } });

    expect(items(draft)).toMatchObject([
      { type: "thinking", content: "AB", finished: true },
      { type: "tool_use", id: "tool-1" },
      { type: "thinking", content: "C" },
    ]);
  });

  it("does not append text across a tool boundary", () => {
    const draft = createDraft();

    processEvent(draft, { type: "StepBegin", payload: { n: 1 } });
    processEvent(draft, { type: "ContentPart", payload: { type: "text", text: "Before" } });
    processEvent(draft, toolCall("tool-1", "Read"));
    processEvent(draft, { type: "ContentPart", payload: { type: "text", text: "After" } });

    expect(items(draft)).toMatchObject([
      { type: "text", content: "Before", finished: true },
      { type: "tool_use", id: "tool-1" },
      { type: "text", content: "After" },
    ]);
    expect(assistant(draft).content).toBe("BeforeAfter");
  });
});
