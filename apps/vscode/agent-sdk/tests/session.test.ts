import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionError } from "../errors";
import type { StreamEvent, RunResult, ContentPart } from "../schema";

// ============================================================================
// Mock ProtocolClient
// ============================================================================

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockSendPrompt = vi.fn();
const mockSendCancel = vi.fn();
const mockSendApproval = vi.fn();
const mockApplyConfig = vi.fn();
let mockIsRunning = false;

vi.mock("../protocol", () => {
  function MockProtocolClient() {
    return {
      get isRunning() {
        return mockIsRunning;
      },
      start: mockStart,
      stop: mockStop,
      sendPrompt: mockSendPrompt,
      sendCancel: mockSendCancel,
      sendApproval: mockSendApproval,
      applyConfig: mockApplyConfig,
    };
  }

  return {
    ProtocolClient: vi.fn(MockProtocolClient),
  };
});

// Import after mock
import { createSession, prompt } from "../session";
import type { Session, Turn } from "../session";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockPromptStream(events: StreamEvent[], result: RunResult) {
  return {
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
    result: Promise.resolve(result),
  };
}

function createMockPromptStreamWithDelay(events: StreamEvent[], result: RunResult, delayMs = 10) {
  return {
    events: (async function* () {
      for (const event of events) {
        await new Promise((r) => setTimeout(r, delayMs));
        yield event;
      }
    })(),
    result: Promise.resolve(result),
  };
}

function createFailingPromptStream(error: Error) {
  let rejectFn!: (err: Error) => void;
  const resultPromise = new Promise<RunResult>((_, reject) => {
    rejectFn = reject;
  });
  resultPromise.catch(() => {});

  return {
    events: (async function* () {
      // Reject the result promise when iteration starts
      rejectFn(error);
      throw error;
    })(),
    result: resultPromise,
  };
}

// ============================================================================
// createSession Tests
// ============================================================================

describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = false;
  });

  it("creates session with required options", () => {
    const session = createSession({ workDir: "/project" });

    expect(session.workDir).toBe("/project");
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(session.state).toBe("idle");
  });

  it("creates session with custom sessionId", () => {
    const session = createSession({
      workDir: "/project",
      sessionId: "custom-session-123",
    });

    expect(session.sessionId).toBe("custom-session-123");
  });

  it("creates session with all options", () => {
    const session = createSession({
      workDir: "/project",
      sessionId: "test-session",
      model: "kimi-k2",
      thinking: true,
      yoloMode: true,
      executable: "/usr/local/bin/kimi",
      env: { MY_VAR: "value" },
    });

    expect(session.workDir).toBe("/project");
    expect(session.sessionId).toBe("test-session");
    expect(session.model).toBe("kimi-k2");
    expect(session.thinking).toBe(true);
    expect(session.mode).toBe("yolo");
    expect(session.yoloMode).toBe(true);
    expect(session.executable).toBe("/usr/local/bin/kimi");
    expect(session.env).toEqual({ MY_VAR: "value" });
  });

  it("uses default values for optional settings", () => {
    const session = createSession({ workDir: "/project" });

    expect(session.model).toBeUndefined();
    expect(session.thinking).toBe(false);
    expect(session.mode).toBe("default");
    expect(session.yoloMode).toBe(false);
    expect(session.executable).toBe("kimi");
    expect(session.env).toEqual({});
  });
});

// ============================================================================
// Session State Management Tests
// ============================================================================

describe("Session state management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = false;
  });

  it("starts in idle state", () => {
    const session = createSession({ workDir: "/project" });
    expect(session.state).toBe("idle");
  });

  it("transitions to active when prompt is called", () => {
    const session = createSession({ workDir: "/project" });

    mockIsRunning = true;
    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    session.prompt("Hello");

    expect(session.state).toBe("active");
  });

  it("transitions back to idle after turn completes", async () => {
    const session = createSession({ workDir: "/project" });

    mockIsRunning = true;
    mockSendPrompt.mockReturnValue(createMockPromptStream([{ type: "ContentPart", payload: { type: "text", text: "Hi" } }], { status: "finished" }));

    const turn = session.prompt("Hello");

    // Consume all events
    for await (const _ of turn) {
      // drain
    }

    expect(session.state).toBe("idle");
  });

  it("transitions to closed after close()", async () => {
    const session = createSession({ workDir: "/project" });

    await session.close();

    expect(session.state).toBe("closed");
  });

  it("throws SESSION_CLOSED when prompting closed session", async () => {
    const session = createSession({ workDir: "/project" });

    await session.close();

    expect(() => session.prompt("Hello")).toThrow(SessionError);
    expect(() => session.prompt("Hello")).toThrow("Session is closed");
  });
});

// ============================================================================
// Session Property Modification Tests
// ============================================================================

describe("Session property modification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = false;
  });

  it("allows modifying model", () => {
    const session = createSession({ workDir: "/project", model: "model-a" });

    session.model = "model-b";

    expect(session.model).toBe("model-b");
  });

  it("allows modifying thinking", () => {
    const session = createSession({ workDir: "/project", thinking: false });

    session.thinking = true;

    expect(session.thinking).toBe(true);
  });

  it("allows modifying yoloMode", () => {
    const session = createSession({ workDir: "/project", yoloMode: false });

    session.yoloMode = true;

    expect(session.mode).toBe("yolo");
    expect(session.yoloMode).toBe(true);
  });

  it("allows modifying mode", () => {
    const session = createSession({ workDir: "/project", mode: "default" });

    session.mode = "auto";

    expect(session.mode).toBe("auto");
    expect(session.yoloMode).toBe(false);
  });

  it("allows modifying executable", () => {
    const session = createSession({ workDir: "/project" });

    session.executable = "/custom/path/kimi";

    expect(session.executable).toBe("/custom/path/kimi");
  });

  it("allows modifying env", () => {
    const session = createSession({ workDir: "/project" });

    session.env = { NEW_VAR: "new_value" };

    expect(session.env).toEqual({ NEW_VAR: "new_value" });
  });
});

// ============================================================================
// Session.prompt() Tests
// ============================================================================

describe("Session.prompt()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("returns a Turn object", () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");

    expect(turn).toBeDefined();
    expect(typeof turn[Symbol.asyncIterator]).toBe("function");
    expect(turn.result).toBeInstanceOf(Promise);
  });

  it("accepts string content", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello, World!");

    for await (const _ of turn) {
      // drain
    }

    expect(mockSendPrompt).toHaveBeenCalledWith("Hello, World!");
  });

  it("accepts ContentPart array", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const content: ContentPart[] = [
      { type: "text", text: "Check this:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ];

    const turn = session.prompt(content);

    for await (const _ of turn) {
      // drain
    }

    expect(mockSendPrompt).toHaveBeenCalledWith(content);
  });

  it("returns same Turn when called multiple times during active state", () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStreamWithDelay([], { status: "finished" }, 100));

    const turn1 = session.prompt("First");
    const turn2 = session.prompt("Second");

    expect(turn1).toBe(turn2);
  });

  it("queues multiple messages", async () => {
    const session = createSession({ workDir: "/project" });

    let callCount = 0;
    mockSendPrompt.mockImplementation((content) => {
      callCount++;
      return createMockPromptStream([{ type: "ContentPart", payload: { type: "text", text: `Response ${callCount}` } }], { status: "finished" });
    });

    const turn = session.prompt("First");
    session.prompt("Second");
    session.prompt("Third");

    const events: StreamEvent[] = [];
    for await (const event of turn) {
      events.push(event);
    }

    expect(mockSendPrompt).toHaveBeenCalledTimes(3);
    expect(mockSendPrompt).toHaveBeenNthCalledWith(1, "First");
    expect(mockSendPrompt).toHaveBeenNthCalledWith(2, "Second");
    expect(mockSendPrompt).toHaveBeenNthCalledWith(3, "Third");
    expect(events).toHaveLength(3);
  });

  it("starts new client on first prompt", async () => {
    mockIsRunning = false;

    const session = createSession({
      workDir: "/project",
      sessionId: "test-123",
      model: "kimi-k2",
      thinking: true,
    });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    // After start, client becomes running
    mockStart.mockImplementation(() => {
      mockIsRunning = true;
    });

    const turn = session.prompt("Hello");

    for await (const _ of turn) {
      // drain
    }

    expect(mockStart).toHaveBeenCalledWith({
      sessionId: "test-123",
      workDir: "/project",
      model: "kimi-k2",
      thinking: true,
      mode: "default",
      executablePath: "kimi",
      environmentVariables: {},
    });
  });
});

// ============================================================================
// Session Config Hot-Reload Tests
// ============================================================================

describe("Session config hot-reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("applies config without restarting client when model changes", async () => {
    const session = createSession({ workDir: "/project", model: "model-a" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    // First prompt
    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    // Change model
    session.model = "model-b";

    // Second prompt - should hot-update client config
    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    expect(mockStop).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockApplyConfig).toHaveBeenCalledWith(expect.objectContaining({ model: "model-b" }));
  });

  it("applies config without restarting client when thinking changes", async () => {
    const session = createSession({ workDir: "/project", thinking: false });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    session.thinking = true;

    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    expect(mockStop).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockApplyConfig).toHaveBeenCalledWith(expect.objectContaining({ thinking: true }));
  });

  it("applies config without restarting client when mode changes", async () => {
    const session = createSession({ workDir: "/project", yoloMode: false });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    session.mode = "auto";

    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    expect(mockStop).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockApplyConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: "auto" }));
  });

  it("restarts client when executable changes", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    session.executable = "/new/path/kimi";

    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    expect(mockStop).toHaveBeenCalled();
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ executablePath: "/new/path/kimi" }));
  });

  it("restarts client when env changes", async () => {
    const session = createSession({ workDir: "/project", env: { A: "1" } });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    session.env = { B: "2" };

    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    expect(mockStop).toHaveBeenCalled();
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ environmentVariables: { B: "2" } }));
  });

  it("reuses client when config unchanged", async () => {
    const session = createSession({ workDir: "/project", model: "kimi-k2" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn1 = session.prompt("First");
    for await (const _ of turn1) {
      // drain
    }

    // No config change

    const turn2 = session.prompt("Second");
    for await (const _ of turn2) {
      // drain
    }

    // Should only start once
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("serializes concurrent restart calls", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));
    mockStart.mockImplementation(() => {
      mockIsRunning = true;
    });

    const turn = session.prompt("First");
    for await (const _ of turn) {
      // drain
    }

    let resolveStop!: () => void;
    mockStop.mockImplementation(() => {
      mockIsRunning = false;
      return new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
    });

    session.executable = "/new/path/kimi";

    const firstRestart = session.ensureStarted();
    const secondRestart = session.ensureStarted();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);

    resolveStop();
    await Promise.all([firstRestart, secondRestart]);

    expect(mockStart).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Session.close() Tests
// ============================================================================

describe("Session.close()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("stops the client", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    // Start a prompt to create client
    const turn = session.prompt("Hello");
    for await (const _ of turn) {
      // drain
    }

    await session.close();

    expect(mockStop).toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");
    for await (const _ of turn) {
      // drain
    }

    await session.close();
    await session.close();
    await session.close();

    // Should only stop once
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("works when no client was created", async () => {
    const session = createSession({ workDir: "/project" });

    await session.close();

    expect(mockStop).not.toHaveBeenCalled();
    expect(session.state).toBe("closed");
  });

  it("supports Symbol.asyncDispose", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");
    for await (const _ of turn) {
      // drain
    }

    await session[Symbol.asyncDispose]();

    expect(mockStop).toHaveBeenCalled();
    expect(session.state).toBe("closed");
  });
});

// ============================================================================
// Turn Async Iteration Tests
// ============================================================================

describe("Turn async iteration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("yields all events from stream", async () => {
    const session = createSession({ workDir: "/project" });

    const expectedEvents: StreamEvent[] = [
      { type: "TurnBegin", payload: { user_input: "Hello" } },
      { type: "StepBegin", payload: { n: 1 } },
      { type: "ContentPart", payload: { type: "text", text: "Hi there!" } },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(expectedEvents, { status: "finished" }));

    const turn = session.prompt("Hello");

    const events: StreamEvent[] = [];
    for await (const event of turn) {
      events.push(event);
    }

    expect(events).toEqual(expectedEvents);
  });

  it("returns RunResult when iteration completes", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");

    for await (const _ of turn) {
      // drain
    }

    const result = await turn.result;

    expect(result).toEqual({ status: "finished" });
  });

  it("handles max_steps_reached result", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "max_steps_reached", steps: 100 }));

    const turn = session.prompt("Hello");

    for await (const _ of turn) {
      // drain
    }

    const result = await turn.result;

    expect(result).toEqual({ status: "max_steps_reached", steps: 100 });
    expect(session.state).toBe("idle");
  });

  it("handles cancelled result", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "cancelled" }));

    const turn = session.prompt("Hello");

    for await (const _ of turn) {
      // drain
    }

    const result = await turn.result;

    expect(result).toEqual({ status: "cancelled" });
    expect(session.state).toBe("idle");
  });

  it("propagates errors during iteration", async () => {
    const session = createSession({ workDir: "/project" });

    const error = new Error("Stream error");
    mockSendPrompt.mockReturnValue(createFailingPromptStream(error));

    const turn = session.prompt("Hello");

    await expect(async () => {
      for await (const _ of turn) {
        // drain
      }
    }).rejects.toThrow("Stream error");

    await expect(turn.result).rejects.toThrow("Stream error");
  });

  it("handles ToolCall events", async () => {
    const session = createSession({ workDir: "/project" });

    const events: StreamEvent[] = [
      {
        type: "ToolCall",
        payload: {
          type: "function",
          id: "tc-1",
          function: { name: "Shell", arguments: '{"command":"ls"}' },
        },
      },
      {
        type: "ToolResult",
        payload: {
          tool_call_id: "tc-1",
          return_value: {
            is_error: false,
            output: "file1.txt\nfile2.txt",
            message: "Command executed",
            display: [],
          },
        },
      },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const turn = session.prompt("List files");

    const received: StreamEvent[] = [];
    for await (const event of turn) {
      received.push(event);
    }

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("ToolCall");
    expect(received[1].type).toBe("ToolResult");
  });

  it("handles ApprovalRequest events", async () => {
    const session = createSession({ workDir: "/project" });

    const events: StreamEvent[] = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-1",
          tool_call_id: "tc-1",
          sender: "Shell",
          action: "run command",
          description: "Run `rm -rf node_modules`",
        },
      },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const turn = session.prompt("Clean up");

    const received: StreamEvent[] = [];
    for await (const event of turn) {
      received.push(event);
    }

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("ApprovalRequest");
  });
});

// ============================================================================
// Turn.interrupt() Tests
// ============================================================================

describe("Turn.interrupt()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
    mockSendCancel.mockResolvedValue(undefined);
  });

  it("calls sendCancel on client", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(
      createMockPromptStreamWithDelay(
        [
          { type: "ContentPart", payload: { type: "text", text: "Part 1" } },
          { type: "ContentPart", payload: { type: "text", text: "Part 2" } },
        ],
        { status: "finished" },
        50,
      ),
    );

    const turn = session.prompt("Hello");

    // Start iteration then interrupt
    setTimeout(() => turn.interrupt(), 10);

    const events: StreamEvent[] = [];
    for await (const event of turn) {
      events.push(event);
    }

    expect(mockSendCancel).toHaveBeenCalled();
  });

  it("clears pending messages when interrupted during iteration", async () => {
    const session = createSession({ workDir: "/project" });

    let callCount = 0;
    mockSendPrompt.mockImplementation(() => {
      callCount++;
      // First call takes longer, giving time to queue more and interrupt
      const delay = callCount === 1 ? 30 : 10;
      return createMockPromptStreamWithDelay([{ type: "ContentPart", payload: { type: "text", text: `Response ${callCount}` } }], { status: "finished" }, delay);
    });

    const turn = session.prompt("First");
    session.prompt("Second");
    session.prompt("Third");

    // Start consuming, then interrupt after first event
    const events: StreamEvent[] = [];
    let interrupted = false;

    for await (const event of turn) {
      events.push(event);
      if (!interrupted) {
        interrupted = true;
        await turn.interrupt();
      }
    }

    // Should have processed only the first message (interrupt cleared Second and Third)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).toHaveBeenCalledWith("First");
  });

  it("does nothing when client is not running", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");

    // Complete the turn first
    for await (const _ of turn) {
      // drain
    }

    mockIsRunning = false;

    await turn.interrupt();

    expect(mockSendCancel).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Turn.approve() Tests
// ============================================================================

describe("Turn.approve()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
    mockSendApproval.mockResolvedValue(undefined);
  });

  it("sends approval to client", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(
      createMockPromptStreamWithDelay(
        [
          {
            type: "ApprovalRequest",
            payload: {
              id: "req-1",
              tool_call_id: "tc-1",
              sender: "Shell",
              action: "run",
              description: "Run command",
            },
          },
        ],
        { status: "finished" },
        50,
      ),
    );

    const turn = session.prompt("Hello");

    // Consume events and approve
    for await (const event of turn) {
      if (event.type === "ApprovalRequest") {
        await turn.approve(event.payload.id, "approve");
      }
    }

    expect(mockSendApproval).toHaveBeenCalledWith("req-1", "approve");
  });

  it("sends approve_for_session response", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(
      createMockPromptStreamWithDelay(
        [
          {
            type: "ApprovalRequest",
            payload: {
              id: "req-2",
              tool_call_id: "tc-2",
              sender: "WriteFile",
              action: "write",
              description: "Write file",
            },
          },
        ],
        { status: "finished" },
        50,
      ),
    );

    const turn = session.prompt("Write file");

    for await (const event of turn) {
      if (event.type === "ApprovalRequest") {
        await turn.approve(event.payload.id, "approve_for_session");
      }
    }

    expect(mockSendApproval).toHaveBeenCalledWith("req-2", "approve_for_session");
  });

  it("sends reject response", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(
      createMockPromptStreamWithDelay(
        [
          {
            type: "ApprovalRequest",
            payload: {
              id: "req-3",
              tool_call_id: "tc-3",
              sender: "Shell",
              action: "run",
              description: "Run dangerous command",
            },
          },
        ],
        { status: "finished" },
        50,
      ),
    );

    const turn = session.prompt("Do something");

    for await (const event of turn) {
      if (event.type === "ApprovalRequest") {
        await turn.approve(event.payload.id, "reject");
      }
    }

    expect(mockSendApproval).toHaveBeenCalledWith("req-3", "reject");
  });

  it("throws when client is not running", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");

    // Complete the turn
    for await (const _ of turn) {
      // drain
    }

    mockIsRunning = false;

    await expect(turn.approve("req-1", "approve")).rejects.toThrow(SessionError);
    await expect(turn.approve("req-1", "approve")).rejects.toThrow("Cannot approve: no active client");
  });
});

// ============================================================================
// Turn.result Tests
// ============================================================================

describe("Turn.result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("resolves after iteration completes", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([{ type: "ContentPart", payload: { type: "text", text: "Done" } }], { status: "finished" }));

    const turn = session.prompt("Hello");

    // Result should be pending before iteration
    let resolved = false;
    turn.result.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    // Drain events
    for await (const _ of turn) {
      // drain
    }

    // Now result should resolve
    const result = await turn.result;
    expect(result.status).toBe("finished");
  });

  it("rejects when iteration throws", async () => {
    const session = createSession({ workDir: "/project" });

    const error = new Error("Iteration failed");
    mockSendPrompt.mockReturnValue(createFailingPromptStream(error));

    const turn = session.prompt("Hello");

    try {
      for await (const _ of turn) {
        // drain
      }
    } catch {
      // expected
    }

    await expect(turn.result).rejects.toThrow("Iteration failed");
  });

  it("resolves with last result when processing multiple messages", async () => {
    const session = createSession({ workDir: "/project" });

    let callCount = 0;
    mockSendPrompt.mockImplementation(() => {
      callCount++;
      return createMockPromptStream([], {
        status: callCount === 3 ? "max_steps_reached" : "finished",
        steps: callCount === 3 ? 100 : undefined,
      });
    });

    const turn = session.prompt("First");
    session.prompt("Second");
    session.prompt("Third");

    for await (const _ of turn) {
      // drain
    }

    const result = await turn.result;
    expect(result).toEqual({ status: "max_steps_reached", steps: 100 });
  });
});

// ============================================================================
// prompt() One-Shot Function Tests
// ============================================================================

describe("prompt() one-shot function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("creates session, sends message, and returns result", async () => {
    const events: StreamEvent[] = [
      { type: "TurnBegin", payload: { user_input: "Hello" } },
      { type: "ContentPart", payload: { type: "text", text: "Hi!" } },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const { result, events: receivedEvents } = await prompt("Hello", {
      workDir: "/project",
    });

    expect(result).toEqual({ status: "finished" });
    expect(receivedEvents).toEqual(events);
  });

  it("closes session after completion", async () => {
    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    await prompt("Hello", { workDir: "/project" });

    expect(mockStop).toHaveBeenCalled();
  });

  it("closes session even when error occurs", async () => {
    const error = new Error("Prompt failed");
    mockSendPrompt.mockReturnValue(createFailingPromptStream(error));

    await expect(prompt("Hello", { workDir: "/project" })).rejects.toThrow("Prompt failed");

    expect(mockStop).toHaveBeenCalled();
  });

  it("passes options to session", async () => {
    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    await prompt("Hello", {
      workDir: "/project",
      model: "kimi-k2",
      thinking: true,
      yoloMode: true,
    });

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: "/project",
        model: "kimi-k2",
        thinking: true,
        mode: "yolo",
      }),
    );
  });

  it("accepts ContentPart array", async () => {
    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const content: ContentPart[] = [{ type: "text", text: "Test" }];

    await prompt(content, { workDir: "/project" });

    expect(mockSendPrompt).toHaveBeenCalledWith(content);
  });
});

// ============================================================================
// Edge Cases and Error Handling Tests
// ============================================================================

describe("Edge cases and error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = true;
    mockStop.mockResolvedValue(undefined);
  });

  it("handles empty event stream", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");

    const events: StreamEvent[] = [];
    for await (const event of turn) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
    expect(await turn.result).toEqual({ status: "finished" });
  });

  it("handles rapid successive prompts", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    // Rapid fire prompts
    const turn = session.prompt("1");
    session.prompt("2");
    session.prompt("3");
    session.prompt("4");
    session.prompt("5");

    for await (const _ of turn) {
      // drain
    }

    expect(mockSendPrompt).toHaveBeenCalledTimes(5);
  });

  it("handles client stop error gracefully during close", async () => {
    const session = createSession({ workDir: "/project" });

    mockSendPrompt.mockReturnValue(createMockPromptStream([], { status: "finished" }));

    const turn = session.prompt("Hello");
    for await (const _ of turn) {
      // drain
    }

    mockStop.mockRejectedValue(new Error("Stop failed"));

    // Should not throw
    await session.close();

    expect(session.state).toBe("closed");
  });

  it("generates unique session IDs", () => {
    const sessions = Array.from({ length: 10 }, () => createSession({ workDir: "/project" }));

    const ids = sessions.map((s) => s.sessionId);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(10);
  });

  it("handles SubagentEvent in stream", async () => {
    const session = createSession({ workDir: "/project" });

    const events: StreamEvent[] = [
      {
        type: "SubagentEvent",
        payload: {
          task_tool_call_id: "task-1",
          event: {
            type: "ContentPart",
            payload: { type: "text", text: "From subagent" },
          },
        },
      },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const turn = session.prompt("Start task");

    const received: StreamEvent[] = [];
    for await (const event of turn) {
      received.push(event);
    }

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("SubagentEvent");
  });

  it("handles StatusUpdate events", async () => {
    const session = createSession({ workDir: "/project" });

    const events: StreamEvent[] = [
      {
        type: "StatusUpdate",
        payload: {
          context_usage: 0.75,
          token_usage: {
            input_other: 1000,
            output: 500,
            input_cache_read: 100,
            input_cache_creation: 50,
          },
          message_id: "msg-123",
        },
      },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const turn = session.prompt("Hello");

    const received: StreamEvent[] = [];
    for await (const event of turn) {
      received.push(event);
    }

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("StatusUpdate");
    if (received[0].type === "StatusUpdate") {
      expect(received[0].payload.context_usage).toBe(0.75);
    }
  });

  it("handles CompactionBegin and CompactionEnd events", async () => {
    const session = createSession({ workDir: "/project" });

    const events: StreamEvent[] = [
      { type: "CompactionBegin", payload: {} },
      { type: "CompactionEnd", payload: {} },
    ];

    mockSendPrompt.mockReturnValue(createMockPromptStream(events, { status: "finished" }));

    const turn = session.prompt("Long conversation");

    const received: StreamEvent[] = [];
    for await (const event of turn) {
      received.push(event);
    }

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("CompactionBegin");
    expect(received[1].type).toBe("CompactionEnd");
  });
});
