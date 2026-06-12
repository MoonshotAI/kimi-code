import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_KIMI_CODE_HOME = process.env.KIMI_CODE_HOME;
let tmpHome: string | null = null;

async function setupHistoryFixture() {
  tmpHome = await mkdtemp(join(tmpdir(), "kimi-vscode-history-"));
  process.env.KIMI_CODE_HOME = tmpHome;
  vi.resetModules();

  const { KimiPaths } = await import("../paths");
  const workDir = "/tmp/example-workspace";
  const sessionId = "session_11111111-1111-4111-8111-111111111111";
  const sessionDir = KimiPaths.sessionDir(workDir, sessionId);
  const wireDir = join(sessionDir, "agents", "main");
  await mkdir(wireDir, { recursive: true });

  return { workDir, sessionId, sessionDir, wireFile: join(wireDir, "wire.jsonl") };
}

afterEach(async () => {
  if (ORIGINAL_KIMI_CODE_HOME === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = ORIGINAL_KIMI_CODE_HOME;
  }
  vi.resetModules();
  if (tmpHome) {
    await rm(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
});

describe("history parsing", () => {
  it("loads record-format history from agents/main/wire.jsonl", async () => {
    const { workDir, sessionId, wireFile } = await setupHistoryFixture();

    await writeFile(
      wireFile,
      [
        JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1 }),
        JSON.stringify({
          type: "context.append_message",
          message: { role: "user", content: [{ type: "text", text: "hello" }], toolCalls: [], origin: { kind: "user" } },
        }),
        JSON.stringify({
          type: "context.append_message",
          message: { role: "user", content: [{ type: "text", text: "<system-reminder>hidden</system-reminder>" }], toolCalls: [], origin: { kind: "injection" } },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "step.begin", step: 1 },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "content.part", part: { type: "text", text: "hi there" } },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "tool.call", toolCallId: "tool-1", name: "Shell", args: { command: "echo hi" } },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "tool.result", toolCallId: "tool-1", result: { output: "hi", is_error: false } },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { parseSessionEvents } = await import("../history/context-extract");
    const events = await parseSessionEvents(workDir, sessionId);

    expect(events.map((event) => event.type)).toEqual(["TurnBegin", "StepBegin", "ContentPart", "ToolCall", "ToolResult"]);
    expect(events[0]).toMatchObject({ type: "TurnBegin", payload: { user_input: [{ type: "text", text: "hello" }] } });
    expect(events[3]).toMatchObject({ type: "ToolCall", payload: { id: "tool-1", function: { name: "Shell", arguments: '{"command":"echo hi"}' } } });
    expect(events[4]).toMatchObject({ type: "ToolResult", payload: { tool_call_id: "tool-1", return_value: { output: "hi" } } });
  });

  it("lists sessions that only have agents/main/wire.jsonl", async () => {
    const { workDir, sessionId, wireFile } = await setupHistoryFixture();

    await writeFile(
      wireFile,
      `${JSON.stringify({
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "first prompt" }], toolCalls: [], origin: { kind: "user" } },
      })}\n`,
      "utf-8",
    );

    const { listSessions } = await import("../storage");
    const sessions = await listSessions(workDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: sessionId, brief: "first prompt", contextFile: wireFile });
  });
});
