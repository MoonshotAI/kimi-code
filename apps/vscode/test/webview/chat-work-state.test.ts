import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { useApprovalStore } from "@/stores/approval.store";
import { useChatStore } from "@/stores/chat.store";

function lastWorkState() {
  return useChatStore.getState().messages.at(-1)?.workState;
}

beforeEach(() => {
  useChatStore.setState({
    sessionId: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    handshakeReceived: false,
    pendingQuestion: null,
    queue: [],
  });
  useApprovalStore.getState().clearRequests();
});

describe("assistant work lifecycle", () => {
  it("marks input boundaries, resumed work, and successful completion", () => {
    const chat = useChatStore.getState();
    chat.processEvent({ type: "TurnBegin", payload: { user_input: "Change it" } });
    chat.processEvent({ type: "StepBegin", payload: { n: 1 } });
    expect(lastWorkState()).toBe("working");

    chat.processEvent({
      type: "ApprovalRequest",
      payload: {
        id: "approval-1",
        tool_call_id: "tool-1",
        sender: "Kimi Code",
        action: "Write file",
        description: "src/file.ts",
      },
    });
    expect(lastWorkState()).toBe("input_needed");

    chat.processEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "tool-1",
        return_value: { is_error: false, output: "ok", message: "", display: [] },
      },
    });
    expect(lastWorkState()).toBe("working");

    chat.processEvent({
      type: "QuestionRequest",
      payload: {
        id: "question-1",
        tool_call_id: "question-tool",
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
      },
    });
    expect(lastWorkState()).toBe("question_pending");

    chat.processEvent({ type: "ContentPart", payload: { type: "text", text: "Done" } });
    expect(lastWorkState()).toBe("working");

    chat.processEvent({ type: "stream_complete", result: { status: "finished" } });
    expect(lastWorkState()).toBe("complete");
  });

  it("keeps warnings active and marks interruptions and failures stopped", () => {
    const chat = useChatStore.getState();
    chat.processEvent({ type: "TurnBegin", payload: { user_input: "Run it" } });
    chat.processEvent({ type: "StepBegin", payload: { n: 1 } });
    chat.processEvent({
      type: "error",
      code: "rate_limit_warning",
      message: "Retrying",
      phase: "runtime",
      terminal: false,
    });
    expect(lastWorkState()).toBe("working");

    chat.processEvent({ type: "StepInterrupted", payload: {} });
    expect(lastWorkState()).toBe("stopped");

    chat.processEvent({ type: "TurnBegin", payload: { user_input: "Try again" } });
    chat.processEvent({ type: "StepBegin", payload: { n: 1 } });
    chat.processEvent({ type: "error", code: "provider_error", message: "Failed", phase: "runtime" });
    expect(lastWorkState()).toBe("stopped");
  });
});
