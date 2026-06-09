import { describe, expect, it } from "vitest";
import { AcpLegacyEventTranslator, normalizeAcpMode } from "../acp-legacy-events";

describe("AcpLegacyEventTranslator", () => {
  it("translates replayed user messages unless live user echo is suppressed", () => {
    const translator = new AcpLegacyEventTranslator();

    expect(
      translator.sessionUpdateToEvents({
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system>hidden</system>Hello" } },
      }),
    ).toEqual([{ type: "TurnBegin", payload: { user_input: "Hello" } }, { type: "StepBegin", payload: { n: 1 } }]);

    expect(
      translator.sessionUpdateToEvents(
        {
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } },
        },
        { suppressUserEcho: true },
      ),
    ).toEqual([]);
  });

  it("translates message, thinking, plan, config, and slash command updates", () => {
    const translator = new AcpLegacyEventTranslator();

    expect(translator.sessionUpdateToEvents({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } })).toEqual([
      { type: "ContentPart", payload: { type: "text", text: "Hi" } },
    ]);
    expect(translator.sessionUpdateToEvents({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "reasoning", reasoning: "Think" } } })).toEqual([
      { type: "ContentPart", payload: { type: "think", think: "Think" } },
    ]);
    expect(
      translator.sessionUpdateToEvents({
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "One", status: "active", priority: "urgent" },
            { content: "Two", status: "in_progress", priority: "high" },
          ],
        },
      }),
    ).toEqual([{ type: "Plan", payload: { entries: [{ content: "One", status: "pending" }, { content: "Two", status: "in_progress", priority: "high" }] } }]);
    expect(
      translator.sessionUpdateToEvents({
        update: { sessionUpdate: "config_option_update", configOptions: [{ id: "model" }, null, "bad"] },
      }),
    ).toEqual([{ type: "ConfigOptionUpdate", payload: { configOptions: [{ id: "model" }] } }]);
    expect(
      translator.sessionUpdateToEvents({
        update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/clear", description: "Clear" }, { description: "bad" }] },
      }),
    ).toEqual([{ type: "AvailableCommandsUpdate", payload: { availableCommands: [{ name: "clear", description: "Clear" }] } }]);
    expect(
      translator.sessionUpdateToEvents({
        update: {
          sessionUpdate: "usage_update",
          used: 10,
          size: 100,
          _meta: {
            contextUsage: 0.12,
            currentTurn: {
              input_other: 1,
              output: 2,
              input_cache_read: 3,
              input_cache_creation: 4,
            },
          },
        },
      }),
    ).toEqual([
      {
        type: "StatusUpdate",
        payload: {
          context_usage: 0.12,
          context_tokens: 10,
          max_context_tokens: 100,
          token_usage: {
            input_other: 1,
            output: 2,
            input_cache_read: 3,
            input_cache_creation: 4,
          },
          message_id: null,
        },
      },
    ]);
  });

  it("keeps tool call delta state and emits rich tool results", () => {
    const translator = new AcpLegacyEventTranslator();

    expect(
      translator.sessionUpdateToEvents({
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Shell", kind: "execute", status: "pending", rawInput: "pnpm test" },
      }),
    ).toEqual([
      {
        type: "ToolCall",
        payload: {
          type: "function",
          id: "tool-1",
          function: { name: "Shell", arguments: "pnpm test" },
          extras: { kind: "execute", status: "pending" },
        },
      },
    ]);

    expect(
      translator.sessionUpdateToEvents({
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Shell", status: "running", rawInput: "pnpm test --runInBand" },
      }),
    ).toEqual([{ type: "ToolCallPart", payload: { tool_call_id: "tool-1", arguments_part: " --runInBand" } }]);

    expect(
      translator.sessionUpdateToEvents({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Shell",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "done" } },
            { type: "diff", path: "src/index.ts", oldText: "a", newText: "b" },
          ],
        },
      }),
    ).toEqual([
      {
        type: "ToolResult",
        payload: {
          tool_call_id: "tool-1",
          return_value: {
            is_error: false,
            output: "done",
            message: "Shell",
            display: [
              { type: "brief", text: "done" },
              { type: "diff", path: "src/index.ts", old_text: "a", new_text: "b" },
            ],
            extras: { status: "completed" },
          },
        },
      },
    ]);
  });

  it("preserves numeric permission request ids and dynamic approval options", () => {
    const translator = new AcpLegacyEventTranslator();

    expect(
      translator.permissionRequestToEvent(0, {
        toolCall: {
          toolCallId: "perm-1",
          title: "Edit",
          content: [{ type: "diff", path: "README.md", oldText: "old", newText: "new" }],
        },
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow" },
          { optionId: "reject", name: "Reject", kind: "deny" },
        ],
      }),
    ).toEqual({
      type: "ApprovalRequest",
      payload: {
        id: 0,
        tool_call_id: "perm-1",
        sender: "Edit",
        action: "allow, deny",
        description: "Modify README.md",
        display: [{ type: "diff", path: "README.md", old_text: "old", new_text: "new" }],
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow" },
          { optionId: "reject", name: "Reject", kind: "deny" },
        ],
      },
    });
  });

  it("keeps rich ACP approval display blocks in legacy display", () => {
    const translator = new AcpLegacyEventTranslator();

    expect(
      translator.permissionRequestToEvent("approval-rich", {
        toolCall: {
          toolCallId: "tool-rich",
          title: "Shell",
          content: [
            { type: "command", command: "pnpm test", cwd: "/repo", description: "Run tests" },
            { type: "file-op", operation: "read", path: "README.md", detail: "Inspect docs" },
          ],
        },
        options: [{ optionId: "approve", name: "Approve", kind: "allow" }],
      }),
    ).toMatchObject({
      type: "ApprovalRequest",
      payload: {
        description: "Run tests\nread README.md\nInspect docs",
        display: [
          { type: "command", language: "bash", command: "pnpm test", cwd: "/repo", description: "Run tests" },
          { type: "file-op", operation: "read", path: "README.md", detail: "Inspect docs" },
        ],
      },
    });
  });

  it("normalizes ACP mode options", () => {
    expect(normalizeAcpMode({ mode: "plan" })).toBe("plan");
    expect(normalizeAcpMode({ mode: undefined, yoloMode: true })).toBe("yolo");
    expect(normalizeAcpMode({ mode: undefined, yoloMode: false })).toBe("default");
  });
});
