/**
 * Scenario: a resumed Node SDK transcript is rendered through the released VS Code Webview protocol.
 * Responsibilities: visible turns, media, assistant/tool output, subagent routing, compaction, plan state, and hidden injections.
 * Wiring: the pure replay adapter and public SDK replay types are used directly; there are no stubs.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/replay-adapter.test.ts
 */

import type {
  AgentReplayRecord,
  ContentPart,
  ResumedAgentState,
  ResumedSessionState,
  ToolCall,
} from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it } from "vitest";

import {
  replayRecordTurnCount,
  replaySessionToWebviewEvents,
  replayToWebviewEvents,
} from "../src/runtime/replay-adapter";

type ReplayMessage = Extract<AgentReplayRecord, { type: "message" }>["message"];

function message(
  role: ReplayMessage["role"],
  content: ContentPart[],
  options: {
    readonly toolCalls?: ToolCall[];
    readonly toolCallId?: string;
    readonly isError?: boolean;
    readonly origin?: ReplayMessage["origin"];
  } = {},
): ReplayMessage {
  return {
    role,
    content,
    toolCalls: options.toolCalls ?? [],
    toolCallId: options.toolCallId,
    isError: options.isError,
    origin: options.origin,
  };
}

function record(messageValue: ReplayMessage, time: number = 1): AgentReplayRecord {
  return { type: "message", message: messageValue, time };
}

function resumedAgent(
  replay: readonly AgentReplayRecord[],
  options: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly plan?: ResumedAgentState["plan"];
    readonly contextTokenCount?: number;
    readonly usage?: ResumedAgentState["usage"];
    readonly type?: ResumedAgentState["type"];
  } = {},
): ResumedAgentState {
  return {
    type: options.type ?? "main",
    config: {
      cwd: "/workspace",
      modelAlias: options.modelAlias ?? "kimi-test",
      modelCapabilities: {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 128_000,
      },
      thinkingEffort: options.thinkingEffort ?? "off",
      systemPrompt: "",
    },
    context: { history: [], tokenCount: options.contextTokenCount ?? 0 },
    replay,
    permission: { mode: "manual", rules: [] },
    plan: options.plan ?? null,
    usage: options.usage ?? {},
    tools: [],
    background: [],
  };
}

function replay(records: readonly AgentReplayRecord[]) {
  return replayToWebviewEvents(resumedAgent(records), "session-1");
}

describe("replay adapter (renders the public SDK resume state for the Webview)", () => {
  it("restores the selected model before transcript events", () => {
    const agent = resumedAgent([]);

    expect(replayToWebviewEvents(agent, "session-1")[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { model: "kimi-test" },
    });
  });

  it("restores thinking effort before transcript events", () => {
    const agent = resumedAgent([], { thinkingEffort: "high" });

    expect(replayToWebviewEvents(agent, "session-1")[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { thinking_effort: "high" },
    });
  });

  it("restores active plan mode before transcript events", () => {
    const agent = resumedAgent([], {
      plan: { id: "plan-1", content: "Plan", path: "/workspace/plan.md" },
    });

    expect(replayToWebviewEvents(agent, "session-1")[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { plan_mode: true },
    });
  });

  it("restores context usage after all transcript turns", () => {
    const agent = resumedAgent([], { contextTokenCount: 32_000 });

    expect(replayToWebviewEvents(agent, "session-1").at(-1)).toMatchObject({
      type: "StatusUpdate",
      payload: { context_usage: 0.25 },
    });
  });

  it("restores cumulative token usage exactly once after all transcript turns", () => {
    const agent = resumedAgent([], {
      usage: {
        total: {
          inputOther: 10,
          output: 4,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
    });

    const statusEvents = replayToWebviewEvents(agent, "session-1").filter(
      (event) =>
        event.type === "StatusUpdate" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "token_usage" in event.payload,
    );
    expect(statusEvents).toEqual([
      {
        type: "StatusUpdate",
        payload: {
          context_usage: 0,
          token_usage: {
            input_other: 10,
            output: 4,
            input_cache_read: 3,
            input_cache_creation: 2,
          },
        },
        _sessionId: "session-1",
      },
    ]);
  });

  it("opens one visible turn when replay contains a user prompt", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Fix the test" }], { origin: { kind: "user" } })),
    ]);

    expect(events.filter((event) => event.type !== "StatusUpdate")).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: [{ type: "text", text: "Fix the test" }] },
        _sessionId: "session-1",
      },
      {
        type: "stream_complete",
        result: { status: "finished" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("converts SDK media keys when replay renders a user prompt", () => {
    const events = replay([
      record(
        message(
          "user",
          [
            { type: "image_url", imageUrl: { url: "file:///workspace/a.png", id: "image-1" } },
            { type: "audio_url", audioUrl: { url: "file:///workspace/a.mp3", id: "audio-1" } },
            { type: "video_url", videoUrl: { url: "file:///workspace/a.mp4", id: "video-1" } },
          ],
          { origin: { kind: "user" } },
        ),
      ),
    ]);

    expect(events.find((event) => event.type === "TurnBegin")).toEqual({
      type: "TurnBegin",
      payload: {
        user_input: [
          { type: "image_url", image_url: { url: "file:///workspace/a.png", id: "image-1" } },
          { type: "audio_url", audio_url: { url: "file:///workspace/a.mp3", id: "audio-1" } },
          { type: "video_url", video_url: { url: "file:///workspace/a.mp4", id: "video-1" } },
        ],
      },
      _sessionId: "session-1",
    });
  });

  it("renders assistant text inside the open turn", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Explain" }], { origin: { kind: "user" } })),
      record(message("assistant", [{ type: "text", text: "Here is the answer" }]), 2),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "text", text: "Here is the answer" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("renders signed thinking inside the open turn", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Explain" }], { origin: { kind: "user" } })),
      record(
        message("assistant", [{ type: "think", think: "Reviewing", encrypted: "signature" }]),
        2,
      ),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "think", think: "Reviewing", encrypted: "signature" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("renders assistant media when a resumed answer contains media parts", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Show it" }], { origin: { kind: "user" } })),
      record(
        message("assistant", [
          { type: "image_url", imageUrl: { url: "https://example.test/result.png" } },
          { type: "video_url", videoUrl: { url: "https://example.test/result.mp4" } },
        ]),
        2,
      ),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "image_url", image_url: { url: "https://example.test/result.png" } },
        _sessionId: "session-1",
      },
      {
        type: "ContentPart",
        payload: { type: "video_url", video_url: { url: "https://example.test/result.mp4" } },
        _sessionId: "session-1",
      },
    ]);
  });

  it("maps an assistant tool call to the released tool name", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Read it" }], { origin: { kind: "user" } })),
      record(
        message("assistant", [], {
          toolCalls: [
            {
              type: "function",
              id: "tool-1",
              name: "Read",
              arguments: '{"path":"README.md"}',
            },
          ],
        }),
        2,
      ),
    ]);

    expect(events).toContainEqual({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "tool-1",
        function: { name: "ReadFile", arguments: '{"path":"README.md"}' },
      },
      _sessionId: "session-1",
    });
  });

  it("renders a failed tool result in the open turn", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Run it" }], { origin: { kind: "user" } })),
      record(
        message("tool", [{ type: "text", text: "command failed" }], {
          toolCallId: "tool-1",
          isError: true,
        }),
        2,
      ),
    ]);

    expect(events).toContainEqual({
      type: "ToolResult",
      payload: {
        tool_call_id: "tool-1",
        return_value: {
          is_error: true,
          output: [{ type: "text", text: "command failed" }],
          message: "",
          display: [],
        },
      },
      _sessionId: "session-1",
    });
  });

  it("closes a completed compaction when its replay record has a result", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Continue" }], { origin: { kind: "user" } })),
      {
        type: "compaction",
        time: 2,
        result: {
          summary: "Earlier work",
          compactedCount: 6,
          tokensBefore: 1000,
          tokensAfter: 200,
        },
      },
    ]);

    expect(events.filter((event) => event.type.startsWith("Compaction"))).toEqual([
      { type: "CompactionBegin", payload: {}, _sessionId: "session-1" },
      { type: "CompactionEnd", payload: {}, _sessionId: "session-1" },
    ]);
  });

  it("leaves an unfinished compaction open when its replay record has no result", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Continue" }], { origin: { kind: "user" } })),
      { type: "compaction", time: 2, instruction: "Keep decisions" },
    ]);

    expect(events.filter((event) => event.type.startsWith("Compaction"))).toEqual([
      { type: "CompactionBegin", payload: {}, _sessionId: "session-1" },
    ]);
  });

  it("renders plan mode when replay records a plan update inside a turn", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "Make a plan" }], { origin: { kind: "user" } })),
      { type: "plan_updated", time: 2, enabled: true },
    ]);

    expect(events).toContainEqual({
      type: "StatusUpdate",
      payload: { plan_mode: true },
      _sessionId: "session-1",
    });
  });

  it("separates consecutive user prompts into independently completed turns", () => {
    const events = replay([
      record(message("user", [{ type: "text", text: "First" }], { origin: { kind: "user" } }), 1),
      record(message("assistant", [{ type: "text", text: "One" }]), 2),
      record(message("user", [{ type: "text", text: "Second" }], { origin: { kind: "user" } }), 3),
      record(message("assistant", [{ type: "text", text: "Two" }]), 4),
    ]);

    expect(events.filter((event) => event.type !== "StatusUpdate").map((event) => event.type)).toEqual([
      "TurnBegin",
      "StepBegin",
      "ContentPart",
      "stream_complete",
      "TurnBegin",
      "StepBegin",
      "ContentPart",
      "stream_complete",
    ]);
  });

  it("does not expose an injected user message in resumed history", () => {
    const events = replay([
      record(
        message("user", [{ type: "text", text: "<system>hidden reminder</system>" }], {
          origin: { kind: "injection", variant: "system_reminder" },
        }),
      ),
      record(message("user", [{ type: "text", text: "Visible prompt" }], { origin: { kind: "user" } }), 2),
    ]);

    expect(events.filter((event) => event.type === "TurnBegin")).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: [{ type: "text", text: "Visible prompt" }] },
        _sessionId: "session-1",
      },
    ]);
  });

  it("restores a user-invoked skill as its original slash command", () => {
    const events = replay([
      record(
        message("user", [{ type: "text", text: "<expanded skill prompt>" }], {
          origin: {
            kind: "skill_activation",
            activationId: "activation-1",
            skillName: "review",
            skillArgs: "focus on errors",
            trigger: "user-slash",
          },
        }),
      ),
    ]);

    expect(events).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: [{ type: "text", text: "/skill:review focus on errors" }] },
      _sessionId: "session-1",
    });
  });

  it("restores imported context as the original command and confirmation", () => {
    const events = replay([
      record(
        message(
          "user",
          [
            {
              type: "text",
              text: "<system>The user imported prior context.</system>",
            },
            {
              type: "text",
              text: '<imported_context source="file &apos;notes.md&apos;">\nPrior decision.\n</imported_context>',
            },
          ],
          { origin: { kind: "user" } },
        ),
      ),
    ]);

    expect(events).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: [{ type: "text", text: "/import notes.md" }] },
      _sessionId: "session-1",
    });
    expect(events).toContainEqual({
      type: "ContentPart",
      payload: { type: "text", text: "Imported context from file 'notes.md' (15 chars)." },
      _sessionId: "session-1",
    });
    expect(JSON.stringify(events)).not.toContain("Prior decision.");
  });

  it("does not count a model-invoked skill as a user-visible fork turn", () => {
    const records: AgentReplayRecord[] = [
      record(
        message("user", [{ type: "text", text: "<expanded nested skill>" }], {
          origin: {
            kind: "skill_activation",
            activationId: "activation-model",
            skillName: "helper",
            trigger: "model-tool",
          },
        }),
      ),
    ];

    expect(replayRecordTurnCount(records)).toBe(0);
    expect(replay(records).filter((event) => event.type === "TurnBegin")).toEqual([]);
  });

  it("counts only visible prompts when replay reports the number of turns", () => {
    const records: AgentReplayRecord[] = [
      record(message("user", [{ type: "text", text: "First" }], { origin: { kind: "user" } }), 1),
      record(
        message("user", [{ type: "text", text: "Hidden" }], {
          origin: { kind: "injection", variant: "system_reminder" },
        }),
        2,
      ),
      record(
        message("user", [{ type: "text", text: "/review" }], {
          origin: {
            kind: "plugin_command",
            activationId: "activation-1",
            pluginId: "review-plugin",
            commandName: "review",
            trigger: "user-slash",
          },
        }),
        3,
      ),
    ];

    expect(replayRecordTurnCount(records)).toBe(2);
  });

  it("routes repeated runs of one subagent to their corresponding Agent calls", () => {
    const main = resumedAgent([
      record(message("user", [{ type: "text", text: "First" }], { origin: { kind: "user" } }), 1),
      record(message("assistant", [], {
        toolCalls: [{ type: "function", id: "agent-call-1", name: "Agent", arguments: "{}" }],
      }), 2),
      record(message("tool", [{ type: "text", text: "agent_id: sub-1\nstatus: completed" }], {
        toolCallId: "agent-call-1",
      }), 5),
      record(message("user", [{ type: "text", text: "Second" }], { origin: { kind: "user" } }), 10),
      record(message("assistant", [], {
        toolCalls: [{ type: "function", id: "agent-call-2", name: "Agent", arguments: "{}" }],
      }), 11),
      record(message("tool", [{ type: "text", text: "agent_id: sub-1\nstatus: completed" }], {
        toolCallId: "agent-call-2",
      }), 14),
    ]);
    const child = resumedAgent([
      record(message("user", [{ type: "text", text: "child one" }], {
        origin: { kind: "system_trigger", name: "subagent" },
      }), 3),
      record(message("assistant", [{ type: "text", text: "first child answer" }]), 4),
      record(message("user", [{ type: "text", text: "child two" }], {
        origin: { kind: "system_trigger", name: "subagent" },
      }), 12),
      record(message("assistant", [{ type: "text", text: "second child answer" }]), 13),
    ], { type: "sub" });
    const state: ResumedSessionState = {
      sessionMetadata: {
        createdAt: "",
        updatedAt: "",
        title: "",
        isCustomTitle: false,
        agents: {
          main: { type: "main", parentAgentId: null },
          "sub-1": { type: "sub", parentAgentId: "main" },
        },
        custom: {},
      },
      agents: { main, "sub-1": child },
    };

    const events = replaySessionToWebviewEvents(state, "session-1");

    expect(events).toContainEqual(expect.objectContaining({
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: "agent-call-1",
        event: { type: "ContentPart", payload: { type: "text", text: "first child answer" } },
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: "agent-call-2",
        event: { type: "ContentPart", payload: { type: "text", text: "second child answer" } },
      },
    }));
  });
});
