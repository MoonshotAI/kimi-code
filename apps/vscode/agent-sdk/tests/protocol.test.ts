import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createEventChannel } from "../protocol";
import { TransportError } from "../errors";

// ============================================================================
// createEventChannel Tests
// ============================================================================
describe("createEventChannel", () => {
  it("pushes and consumes values in order", async () => {
    const { iterable, push, finish } = createEventChannel<number>();

    push(1);
    push(2);
    push(3);
    finish();

    const results: number[] = [];
    for await (const value of iterable) {
      results.push(value);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it("handles async consumption with delayed push", async () => {
    const { iterable, push, finish } = createEventChannel<string>();

    const consumer = (async () => {
      const results: string[] = [];
      for await (const value of iterable) {
        results.push(value);
      }
      return results;
    })();

    await new Promise((r) => setTimeout(r, 10));
    push("a");
    push("b");
    finish();

    const results = await consumer;
    expect(results).toEqual(["a", "b"]);
  });

  it("ignores pushes after finish", async () => {
    const { iterable, push, finish } = createEventChannel<number>();

    push(1);
    finish();
    push(2);
    push(3);

    const results: number[] = [];
    for await (const value of iterable) {
      results.push(value);
    }

    expect(results).toEqual([1]);
  });

  it("handles empty channel", async () => {
    const { iterable, finish } = createEventChannel<number>();
    finish();

    const results: number[] = [];
    for await (const value of iterable) {
      results.push(value);
    }

    expect(results).toEqual([]);
  });

  it("multiple finish calls are safe", async () => {
    const { iterable, push, finish } = createEventChannel<number>();

    push(1);
    finish();
    finish();
    finish();

    const results: number[] = [];
    for await (const value of iterable) {
      results.push(value);
    }

    expect(results).toEqual([1]);
  });

  it("resolves waiting consumers on finish", async () => {
    const { iterable, finish } = createEventChannel<number>();

    const consumer = (async () => {
      const results: number[] = [];
      for await (const value of iterable) {
        results.push(value);
      }
      return results;
    })();

    await new Promise((r) => setTimeout(r, 10));
    finish();

    const results = await consumer;
    expect(results).toEqual([]);
  });
});

// ============================================================================
// ProtocolClient Tests
// ============================================================================
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

let ProtocolClient: (typeof import("../protocol"))["ProtocolClient"];

beforeAll(async () => {
  const module = await import("../protocol.js");
  ProtocolClient = module.ProtocolClient;
});

describe("ProtocolClient", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Create a mock process with proper Readable streams
  function createMockProcess() {
    const stdin = {
      writable: true,
      write: vi.fn(),
    };

    // Use real Readable streams that support readline
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });

    const proc = new EventEmitter() as EventEmitter & {
      stdin: typeof stdin;
      stdout: Readable;
      stderr: Readable;
      exitCode: number | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn();
    return proc;
  }

  // Helper to push a line to stdout
  function pushLine(proc: ReturnType<typeof createMockProcess>, line: string) {
    proc.stdout.push(line + "\n");
  }

  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function parseWrite(proc: ReturnType<typeof createMockProcess>, index: number) {
    return JSON.parse(proc.stdin.write.mock.calls[index][0]);
  }

  async function waitForWrite(proc: ReturnType<typeof createMockProcess>, method: string, fromIndex = 0) {
    for (let attempt = 0; attempt < 50; attempt++) {
      for (let i = fromIndex; i < proc.stdin.write.mock.calls.length; i++) {
        const message = parseWrite(proc, i);
        if (message.method === method) {
          return { index: i, message };
        }
      }
      await tick();
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  async function respondToWrite(proc: ReturnType<typeof createMockProcess>, method: string, result: unknown, fromIndex = 0) {
    const { index, message } = await waitForWrite(proc, method, fromIndex);
    pushLine(proc, JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    await tick();
    return index + 1;
  }

  async function completeLoadHandshake(proc: ReturnType<typeof createMockProcess>, result: unknown = {}) {
    let cursor = await respondToWrite(proc, "initialize", {}, 0);
    return respondToWrite(proc, "session/load", result, cursor);
  }

  async function completeNewHandshake(proc: ReturnType<typeof createMockProcess>, result: unknown = { sessionId: "new-session" }, configRequestCount = 2) {
    let cursor = await respondToWrite(proc, "initialize", {}, 0);
    cursor = await respondToWrite(proc, "session/new", result, cursor);
    for (let i = 0; i < configRequestCount; i++) {
      cursor = await respondToWrite(proc, "session/set_config_option", {}, cursor);
    }
    return cursor;
  }

  describe("isRunning", () => {
    it("returns false when not started", () => {
      const client = new ProtocolClient();
      expect(client.isRunning).toBe(false);
    });
  });

  describe("start", () => {
    it("throws ALREADY_STARTED when called twice", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });

      expect(() => {
        client.start({ sessionId: "test", workDir: "/tmp" });
      }).toThrow(TransportError);
    });

    it("builds correct ACP args with all options", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({
        sessionId: "sess-123",
        workDir: "/project",
        model: "kimi-k2",
        thinking: true,
        yoloMode: true,
        executablePath: "/usr/local/bin/kimi",
        environmentVariables: { MY_VAR: "value" },
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/local/bin/kimi",
        ["acp"],
        expect.objectContaining({
          cwd: "/project",
          env: expect.objectContaining({ MY_VAR: "value" }),
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    });

    it("does not pass legacy thinking flags when thinking is false", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({
        sessionId: "test",
        workDir: "/tmp",
        thinking: false,
      });

      expect(mockSpawn).toHaveBeenCalledWith("kimi", ["acp"], expect.anything());
    });

    it("sets handshake timeout on config option requests during session/new", async () => {
      const timeoutSpy = vi.spyOn(global, "setTimeout");
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ workDir: "/tmp", model: "kimi-k2", thinking: true, mode: "yolo" });
      await completeNewHandshake(proc, { sessionId: "new-session" }, 3);

      const handshakeTimeouts = timeoutSpy.mock.calls.filter((call) => call[1] === 10000);
      expect(handshakeTimeouts.length).toBeGreaterThanOrEqual(5);

      const stopPromise = client.stop();
      proc.exitCode = 0;
      proc.emit("exit", 0);
      await stopPromise;
    });

    it("does not overwrite loaded session config with caller defaults", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({
        sessionId: "existing-session",
        workDir: "/tmp",
        model: "caller-default-model",
        thinking: false,
      });

      await completeLoadHandshake(proc, {
        configOptions: [
          {
            id: "model",
            currentValue: "loaded-model",
            options: [{ value: "loaded-model", name: "Loaded Model" }],
          },
          {
            id: "thinking",
            currentValue: "on",
            options: [
              { value: "off", name: "Thinking Off" },
              { value: "on", name: "Thinking On" },
            ],
          },
        ],
      });
      await client.ensureReady();

      const setConfigRequests = proc.stdin.write.mock.calls.map((_, index) => parseWrite(proc, index)).filter((message) => message.method === "session/set_config_option");
      expect(setConfigRequests).toEqual([]);
      expect(client.consumeBufferedEvents()).toContainEqual({
        type: "ConfigOptionUpdate",
        payload: {
          configOptions: [
            {
              id: "model",
              currentValue: "loaded-model",
              options: [{ value: "loaded-model", name: "Loaded Model" }],
            },
            {
              id: "thinking",
              currentValue: "on",
              options: [
                { value: "off", name: "Thinking Off" },
                { value: "on", name: "Thinking On" },
              ],
            },
          ],
        },
      });

      const stopPromise = client.stop();
      proc.exitCode = 0;
      proc.emit("exit", 0);
      await stopPromise;
    });

    it("skips config option requests already known from session/new", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ workDir: "/tmp", model: "kimi-k2", thinking: false });

      let cursor = await respondToWrite(proc, "initialize", {}, 0);
      cursor = await respondToWrite(
        proc,
        "session/new",
        {
          sessionId: "new-session",
          configOptions: [
            { configId: "thinking", currentValue: "off" },
            { id: "mode", value: "default" },
          ],
        },
        cursor,
      );
      cursor = await respondToWrite(proc, "session/set_config_option", {}, cursor);

      await client.ensureReady();

      const setConfigRequests = proc.stdin.write.mock.calls.map((_, index) => parseWrite(proc, index)).filter((message) => message.method === "session/set_config_option");
      expect(setConfigRequests).toEqual([
        expect.objectContaining({
          method: "session/set_config_option",
          params: expect.objectContaining({ configId: "model", value: "kimi-k2" }),
        }),
      ]);

      const stopPromise = client.stop();
      proc.exitCode = 0;
      proc.emit("exit", 0);
      await stopPromise;
    });

    it("throws SPAWN_FAILED when spawn fails", () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      const client = new ProtocolClient();
      expect(() => {
        client.start({ sessionId: "test", workDir: "/tmp" });
      }).toThrow(TransportError);
    });

    it("throws SPAWN_FAILED when stdio missing", () => {
      const proc = createMockProcess();
      proc.stdout = null as unknown as Readable;
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      expect(() => {
        client.start({ sessionId: "test", workDir: "/tmp" });
      }).toThrow(TransportError);
    });
  });

  describe("stop", () => {
    it("does nothing when not started", async () => {
      const client = new ProtocolClient();
      await client.stop();
    });

    it("kills process on stop", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      await completeLoadHandshake(proc);

      const stopPromise = client.stop();

      proc.exitCode = 0;
      proc.emit("exit", 0);

      await stopPromise;
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  describe("sendPrompt", () => {
    it("writes prompt request to stdin", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const { message } = await waitForWrite(proc, "session/prompt", cursor);

      expect(message.params).toMatchObject({
        sessionId: "test",
        prompt: [{ type: "text", text: "Hello" }],
      });

      pushLine(proc, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      for await (const _ of stream.events) {
        // drain
      }
      await expect(stream.result).resolves.toEqual({ status: "finished" });
    });

    it("handles ContentPart array input", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt([{ type: "text", text: "Hello" }]);
      const { message } = await waitForWrite(proc, "session/prompt", cursor);

      expect(message.params.prompt).toEqual([{ type: "text", text: "Hello" }]);
      pushLine(proc, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      for await (const _ of stream.events) {
        // drain
      }
      await expect(stream.result).resolves.toEqual({ status: "finished" });
    });
  });

  describe("sendCancel", () => {
    it("writes cancel notification to stdin", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      client.sendCancel();
      const { message } = await waitForWrite(proc, "session/cancel", cursor);

      expect(message.id).toBeUndefined();
      expect(message.params).toEqual({ sessionId: "test" });
    });
  });

  describe("sendApproval", () => {
    it("writes approval response to stdin", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });

      client.sendApproval("req-123", "approve");

      expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"id":"req-123"'));
      expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"optionId":"approve_once"'));
    });
  });

  describe("protocol debug logging", () => {
    it("does not log ACP traffic by default and stringifies outgoing messages once", async () => {
      const oldDebug = process.env.KIMI_CODE_DEBUG_ACP;
      delete process.env.KIMI_CODE_DEBUG_ACP;

      try {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const client = new ProtocolClient();
        client.start({ sessionId: "test", workDir: "/tmp" });

        const stringifySpy = vi.spyOn(JSON, "stringify");
        client.sendApproval(0, "approve");

        const stringifyCalls = stringifySpy.mock.calls.length;
        expect(stringifyCalls).toBe(1);
        expect(proc.stdin.write).toHaveBeenLastCalledWith('{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"approve_once"}}}\n');

        pushLine(
          proc,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret chunk" } } },
          }),
        );
        proc.stderr.push("secret stderr\n");
        await tick();

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        if (oldDebug === undefined) {
          delete process.env.KIMI_CODE_DEBUG_ACP;
        } else {
          process.env.KIMI_CODE_DEBUG_ACP = oldDebug;
        }
      }
    });
  });

  describe("message handling", () => {
    it("emits events from session/update notifications", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      // Push event
      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } },
        }),
      );

      // Push response to finish
      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      // Signal end of stream
      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        type: "ContentPart",
        payload: { type: "text", text: "Hi" },
      });
    });

    it("emits thought chunks from Kimi Code even when local thinking is disabled", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp", thinking: false });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First" } } },
        }),
      );
      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden thought" } } },
        }),
      );
      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " second" } } },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "TurnBegin", payload: { user_input: "Hello" } },
        { type: "StepBegin", payload: { n: 1 } },
        { type: "ContentPart", payload: { type: "text", text: "First" } },
        { type: "ContentPart", payload: { type: "think", think: "hidden thought" } },
        { type: "ContentPart", payload: { type: "text", text: " second" } },
      ]);
    });

    it("emits thought chunks when thinking is enabled", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp", thinking: true });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "visible thought" } } },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "TurnBegin", payload: { user_input: "Hello" } },
        { type: "StepBegin", payload: { n: 1 } },
        { type: "ContentPart", payload: { type: "think", think: "visible thought" } },
      ]);
    });

    it("emits thought chunks when thought content uses a reasoning fallback", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp", thinking: true });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { type: "reasoning", reasoning: "visible thought" } } },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "TurnBegin", payload: { user_input: "Hello" } },
        { type: "StepBegin", payload: { n: 1 } },
        { type: "ContentPart", payload: { type: "think", think: "visible thought" } },
      ]);
    });

    it("ignores whitespace-only thought chunks", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp", thinking: true });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "\n  " } } },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "TurnBegin", payload: { user_input: "Hello" } },
        { type: "StepBegin", payload: { n: 1 } },
      ]);
    });

    it("drops replayed user_message_chunk when it only contains a system reminder", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      await completeLoadHandshake(proc);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "user_message_chunk",
              content: {
                type: "text",
                text: "<system-reminder>\nCurrent todo list:\n[pending] Hidden\n</system-reminder>",
              },
            },
          },
        }),
      );
      await tick();

      expect(client.consumeBufferedEvents()).toEqual([]);
    });

    it("removes system reminder blocks from replayed user_message_chunk text", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      await completeLoadHandshake(proc);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "user_message_chunk",
              content: {
                type: "text",
                text: "Real prompt\n<system-reminder>\nCurrent todo list:\n[pending] Hidden\n</system-reminder>",
              },
            },
          },
        }),
      );
      await tick();

      expect(client.consumeBufferedEvents()).toEqual([
        { type: "TurnBegin", payload: { user_input: "Real prompt" } },
        { type: "StepBegin", payload: { n: 1 } },
      ]);
    });

    it("emits todo display blocks from tool_call_update content", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Set todos");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-todo",
              title: "SetTodoList",
              status: "completed",
              content: [
                {
                  type: "todo",
                  items: [
                    { title: "Inspect API", status: "completed" },
                    { content: "Update UI", status: "active" },
                    { text: "Run checks" },
                  ],
                },
              ],
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events[events.length - 1]).toMatchObject({
        type: "ToolResult",
        payload: {
          return_value: {
            display: [
              {
                type: "todo",
                items: [
                  { title: "Inspect API", status: "done" },
                  { title: "Update UI", status: "in_progress" },
                  { title: "Run checks", status: "pending" },
                ],
              },
            ],
          },
        },
      });
    });

    it("emits todo display blocks from nested content block", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Set todos");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-todo-nested",
              title: "SetTodoList",
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: "Updating todos" } },
                { type: "content", content: { type: "todo", items: [{ title: "First" }, { title: "Second", status: "completed" }] } },
              ],
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      const toolResult = events.find((e) => e.type === "ToolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult?.payload.return_value.display).toEqual([
        { type: "brief", text: "Updating todos" },
        {
          type: "todo",
          items: [
            { title: "First", status: "pending" },
            { title: "Second", status: "done" },
          ],
        },
      ]);
    });

    it("emits todo display blocks from plain text todo list", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Set todos");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-todo-text",
              title: "TodoList",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: "Todo list updated.\nCurrent todo list:\n  [pending] Inspect code\n  [in_progress] Update UI\n  [done] Run checks\n",
                  },
                },
              ],
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      const toolResult = events.find((e) => e.type === "ToolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult?.payload.return_value.display).toEqual([
        {
          type: "todo",
          items: [
            { title: "Inspect code", status: "pending" },
            { title: "Update UI", status: "in_progress" },
            { title: "Run checks", status: "done" },
          ],
        },
      ]);
    });

    it("emits todo display blocks from raw output todo list", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Set todos");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-todo-raw-output",
              title: "TodoList",
              status: "completed",
              rawOutput: "Todo list updated.\nCurrent todo list:\n  [pending] Inspect code\n  [pending] Update UI\n  [pending] Run checks\n",
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      const toolResult = events.find((e) => e.type === "ToolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult?.payload.return_value.display).toEqual([
        {
          type: "todo",
          items: [
            { title: "Inspect code", status: "pending" },
            { title: "Update UI", status: "pending" },
            { title: "Run checks", status: "pending" },
          ],
        },
      ]);
    });

    it("emits tool argument parts with the matching tool call id", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Run tool");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-args",
              title: "Shell",
              rawInput: '{"cmd":"ec',
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-args",
              title: "Shell",
              status: "pending",
              rawInput: '{"cmd":"echo ok"}',
            },
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "ToolCallPart",
        payload: { tool_call_id: "tc-args", arguments_part: 'ho ok"}' },
      });
    });

    it("emits request events from session/request_permission", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-1",
          method: "session/request_permission",
          params: {
            sessionId: "test",
            toolCall: {
              toolCallId: "tc-1",
              title: "Shell",
              kind: "execute",
              content: [{ type: "content", content: { type: "text", text: "Run ls" } }],
            },
            options: [{ optionId: "approve_once", kind: "allow" }],
          },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        type: "ApprovalRequest",
        payload: { id: "req-1", sender: "Shell" },
      });
    });

    it("emits ApprovalRequest for numeric id=0 and preserves number type in response", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "test",
            toolCall: {
              toolCallId: "tc-1",
              title: "Shell",
              kind: "execute",
              content: [{ type: "content", content: { type: "text", text: "Run ls" } }],
            },
            options: [{ optionId: "approve_once", kind: "allow" }],
          },
        }),
      );

      // Approve with the numeric id
      client.sendApproval(0, "approve");

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      const approval = events.find((e) => e.type === "ApprovalRequest");
      expect(approval).toMatchObject({
        type: "ApprovalRequest",
        payload: { id: 0, sender: "Shell" },
      });

      // Verify the approval response contains the numeric id 0, not "0"
      const approvalWrite = proc.stdin.write.mock.calls.find((call) => {
        const msg = JSON.parse(call[0]);
        return msg.id === 0 && msg.result?.outcome?.optionId === "approve_once";
      });
      expect(approvalWrite).toBeDefined();
    });

    it("emits parse error for invalid JSON", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(proc, "not valid json{{{");

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        type: "error",
        code: "INVALID_JSON",
      });
    });

    it("ignores unknown ACP session update types", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "test", update: { sessionUpdate: "unknown_update", value: true } },
        }),
      );

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      const events = [];
      for await (const event of stream.events) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "TurnBegin", payload: { user_input: "Hello" } },
        { type: "StepBegin", payload: { n: 1 } },
      ]);
    });

    it("resolves result promise with run result", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: {},
        }),
      );

      proc.stdout.push(null);

      for await (const _ of stream.events) {
        // drain
      }

      const result = await stream.result;
      expect(result).toEqual({ status: "finished" });
    });

    it("handles cancelled stop reason", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: { stopReason: "cancelled" },
        }),
      );

      proc.stdout.push(null);

      for await (const _ of stream.events) {
        // drain
      }

      const result = await stream.result;
      expect(result).toEqual({ status: "cancelled" });
    });

    it("maps max turn request stop reason to max_steps_reached", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });
      const cursor = await completeLoadHandshake(proc);

      const stream = client.sendPrompt("Hello");
      const promptRequest = await waitForWrite(proc, "session/prompt", cursor);

      pushLine(
        proc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: promptRequest.message.id,
          result: { stopReason: "max_turn_requests" },
        }),
      );

      proc.stdout.push(null);

      for await (const _ of stream.events) {
        // drain
      }

      const result = await stream.result;
      expect(result).toEqual({ status: "max_steps_reached" });
    });
  });

  describe("process lifecycle", () => {
    it("handles process error", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });

      const stream = client.sendPrompt("Hello");

      proc.emit("error", new Error("EPIPE"));

      await expect(stream.result).rejects.toThrow(TransportError);
    });

    it("handles process exit with non-zero code", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });

      const stream = client.sendPrompt("Hello");

      proc.exitCode = 1;
      proc.emit("exit", 1);

      await expect(stream.result).rejects.toThrow(TransportError);
    });

    it("rejects pending requests when process exits with code zero", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const client = new ProtocolClient();
      client.start({ sessionId: "test", workDir: "/tmp" });

      const stream = client.sendPrompt("Hello");

      proc.exitCode = 0;
      proc.emit("exit", 0);

      await expect(stream.result).rejects.toThrow(TransportError);
    });
  });
});
