import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  abortChat: vi.fn(),
  streamChat: vi.fn(),
  trackFiles: vi.fn(),
}));

vi.mock("@/services", () => ({ bridge, Events: {} }));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import type { UIStreamEvent } from "../../shared/types";
import { useChatStore } from "../../webview-ui/src/stores/chat.store";

const PROMPT = "Summarize the deploy.";

function turn(...outcome: UIStreamEvent[]): UIStreamEvent[] {
  return [
    { type: "TurnBegin", payload: { user_input: PROMPT, turnIndex: 0 } },
    { type: "StepBegin", payload: { n: 1 } },
    { type: "ContentPart", payload: { type: "text", text: "Partial summary" } },
    ...outcome,
  ];
}

const FAILED: UIStreamEvent = {
  type: "error",
  code: "provider.api_error",
  message: "Service temporarily unavailable.",
  detail: "The example service refused this request.",
  phase: "runtime",
};

beforeEach(() => {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.abortChat.mockResolvedValue({ aborted: true });
  bridge.streamChat.mockResolvedValue(undefined);
});

describe("chat store (restores a resumed session into the Webview)", () => {
  it("lets Retry resend the prompt of a restored failed last turn", async () => {
    const store = useChatStore.getState();
    await store.loadSession("session-1", turn(FAILED));

    expect(useChatStore.getState().messages.at(-1)?.inlineError).toEqual({
      code: "provider.api_error",
      message: "Service temporarily unavailable.",
      detail: "The example service refused this request.",
    });

    useChatStore.getState().retryLastMessage();

    expect(bridge.streamChat).toHaveBeenCalledWith(PROMPT, "", expect.anything(), false, "session-1");
    expect(useChatStore.getState()).toMatchObject({
      isStreaming: true,
      messages: [
        { role: "user", content: PROMPT },
        { role: "assistant", inlineError: undefined },
      ],
    });
  });

  it("leaves nothing to retry when the restored last turn completed", async () => {
    await useChatStore.getState().loadSession("session-1", turn({
      type: "stream_complete",
      result: { status: "finished" },
    }));

    useChatStore.getState().retryLastMessage();

    expect(useChatStore.getState().pendingInput).toBeNull();
    expect(bridge.streamChat).not.toHaveBeenCalled();
  });
});
