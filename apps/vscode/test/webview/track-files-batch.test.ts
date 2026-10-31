import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTrackFilesBatch,
  flushTrackFiles,
  processEvent,
  scheduleTrackFiles,
} from "@/stores/event-handlers";
import type { ChatState } from "@/stores/chat.store";

const boundary = vi.hoisted(() => ({
  trackFiles: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: {
    trackFiles: boundary.trackFiles,
  },
}));

describe("trackFiles batching in webview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    boundary.trackFiles.mockReset();
    clearTrackFilesBatch();
  });

  afterEach(() => {
    clearTrackFilesBatch();
    vi.useRealTimers();
  });

  it("batches multiple scheduleTrackFiles calls into a single bridge call after debounce", () => {
    scheduleTrackFiles(["src/a.ts", "src/b.ts"], 100);
    scheduleTrackFiles(["src/b.ts", "src/c.ts"], 100);

    expect(boundary.trackFiles).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(boundary.trackFiles).toHaveBeenCalledTimes(1);
    expect(boundary.trackFiles).toHaveBeenCalledWith(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("flushTrackFiles dispatches immediately without waiting for debounce timer", () => {
    scheduleTrackFiles(["src/x.ts"], 150);

    expect(boundary.trackFiles).not.toHaveBeenCalled();

    flushTrackFiles();

    expect(boundary.trackFiles).toHaveBeenCalledTimes(1);
    expect(boundary.trackFiles).toHaveBeenCalledWith(["src/x.ts"]);

    vi.advanceTimersByTime(200);
    expect(boundary.trackFiles).toHaveBeenCalledTimes(1);
  });

  it("clearTrackFilesBatch cancels pending timer and discards pending paths", () => {
    scheduleTrackFiles(["src/temp.ts"], 100);
    clearTrackFilesBatch();

    vi.advanceTimersByTime(200);
    expect(boundary.trackFiles).not.toHaveBeenCalled();

    flushTrackFiles();
    expect(boundary.trackFiles).not.toHaveBeenCalled();
  });

  it("coalesces ToolResult paths during event processing until flushed", () => {
    const draft = {
      sessionId: "s1",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          steps: [
            {
              n: 1,
              items: [
                {
                  type: "tool_use",
                  id: "call-1",
                  call: { id: "call-1", name: "Write", arguments: "{}" },
                },
                {
                  type: "tool_use",
                  id: "call-2",
                  call: { id: "call-2", name: "Write", arguments: "{}" },
                },
              ],
            },
          ],
        },
      ],
      isStreaming: true,
      isCompacting: false,
      handshakeReceived: true,
      draftMedia: [],
      lastStatus: null,
      tokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
      activeTokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
      pendingInput: null,
      queue: [],
      pendingQuestion: null,
      planMode: false,
    };

    const toolResultEvent1 = {
      type: "ToolResult" as const,
      payload: {
        tool_call_id: "call-1",
        return_value: {
          display: [{ type: "diff", path: "src/file1.ts" }],
        },
      },
    };

    const toolResultEvent2 = {
      type: "ToolResult" as const,
      payload: {
        tool_call_id: "call-2",
        return_value: {
          display: [{ type: "diff", path: "src/file2.ts" }],
        },
      },
    };

    processEvent(draft as unknown as ChatState, toolResultEvent1 as never);
    processEvent(draft as unknown as ChatState, toolResultEvent2 as never);

    expect(boundary.trackFiles).not.toHaveBeenCalled();

    flushTrackFiles();

    expect(boundary.trackFiles).toHaveBeenCalledTimes(1);
    expect(boundary.trackFiles).toHaveBeenCalledWith(["src/file1.ts", "src/file2.ts"]);
  });
});
