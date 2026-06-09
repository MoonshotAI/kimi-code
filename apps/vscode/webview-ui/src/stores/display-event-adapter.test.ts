import { describe, expect, it } from "vitest";

import { createInitialDisplayState } from "@moonshot-ai/kimi-code-vscode-display-model";
import {
  AcpLegacyEventTranslator,
  type AcpPermissionRequest,
  type AcpSessionNotification,
  type AcpTranslateOptions,
} from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import { SessionErrorCodes } from "@moonshot-ai/kimi-code-vscode-agent-sdk/errors";
import type { UIStreamEvent } from "shared/types";

import { reduceUIStreamEventToDisplay } from "./display-event-adapter";
import {
  agentMessage,
  agentThought,
  availableCommands,
  compactionCompleted,
  compactionStarted,
  permissionNumericId,
  plan,
  stepInterrupted,
  subagentChildToolCall,
  toolCallLifecycle,
  unknownSessionUpdate,
  usageUpdate,
  userMessage,
} from "../../../agent-sdk/tests/fixtures/acp-legacy";

function reduceAll(events: UIStreamEvent[]) {
  let state = createInitialDisplayState();
  const effects = [];

  for (const event of events) {
    const reduction = reduceUIStreamEventToDisplay(state, event);
    state = reduction.state;
    effects.push(...reduction.effects);
  }

  return { state, effects };
}

function reduceLegacyEvents(events: UIStreamEvent[]) {
  return reduceAll(events);
}

function translateSessionUpdateFixture(fixture: { params: AcpSessionNotification; options?: AcpTranslateOptions }): UIStreamEvent[] {
  const translator = new AcpLegacyEventTranslator();
  return translator.sessionUpdateToEvents(fixture.params, fixture.options) as UIStreamEvent[];
}

function translateExtensionFixture(method: string, params: unknown): UIStreamEvent[] {
  const translator = new AcpLegacyEventTranslator();
  return translator.extensionNotificationToEvents(method, params) as UIStreamEvent[];
}

describe("reduceUIStreamEventToDisplay media parts", () => {
  it("keeps user media parts on TurnBegin", () => {
    const { state } = reduceAll([
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

    expect(state.messages[0]?.parts).toEqual([
      { type: "text", text: "look" },
      { type: "media", kind: "image", url: "data:image/png;base64,abc", id: "img-1" },
    ]);
  });

  it("maps assistant media ContentPart events", () => {
    const { state } = reduceAll([
      { type: "TurnBegin", payload: { user_input: "generate" } },
      { type: "StepBegin", payload: { n: 1 } },
      { type: "ContentPart", payload: { type: "video_url", video_url: { url: "data:video/mp4;base64,abc", id: "vid-1" } } },
    ]);

    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: "media", kind: "video", url: "data:video/mp4;base64,abc", id: "vid-1" });
  });
});

describe("reduceUIStreamEventToDisplay terminal events", () => {
  it("maps stream_complete to a completed turn", () => {
    const started = reduceUIStreamEventToDisplay(createInitialDisplayState(), {
      type: "TurnBegin",
      payload: { user_input: "hello" },
    });

    const completed = reduceUIStreamEventToDisplay(
      started.state,
      { type: "stream_complete", result: { status: "completed" } } as unknown as UIStreamEvent,
    );

    expect(completed.state.isStreaming).toBe(false);
    expect(completed.state.messages[1]?.status).toBe("completed");
  });

  it("maps runtime errors to error display parts", () => {
    const { state } = reduceAll([
      { type: "TurnBegin", payload: { user_input: "hello" } },
      {
        type: "error",
        code: "RUNTIME_ERROR",
        message: "Runtime failed",
        phase: "runtime",
        details: { category: "protocol", context: { requestId: "req-1" } },
      },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages[1]?.status).toBe("error");
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: "error",
      error: {
        code: "RUNTIME_ERROR",
        message: "Runtime failed",
        phase: "runtime",
        details: { category: "protocol", context: { requestId: "req-1" } },
      },
    });
  });

  it("maps user interrupt errors to interrupted turns", () => {
    const { state } = reduceAll([
      { type: "TurnBegin", payload: { user_input: "hello" } },
      { type: "error", code: SessionErrorCodes.TURN_INTERRUPTED, message: "ignored", phase: "runtime" },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages[1]?.status).toBe("interrupted");
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: "interrupt",
      reason: SessionErrorCodes.TURN_INTERRUPTED,
      message: "Stopped by user.",
    });
  });

  it("maps StepInterrupted to interrupted turns", () => {
    const { state } = reduceAll([
      { type: "TurnBegin", payload: { user_input: "hello" } },
      { type: "StepInterrupted" } as unknown as UIStreamEvent,
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages[1]?.status).toBe("interrupted");
  });

  it("maps approval resolution to shared pending approval removal", () => {
    const requested = reduceAll([
      { type: "TurnBegin", payload: { user_input: "approve" } },
      {
        type: "ApprovalRequest",
        payload: {
          id: 0,
          tool_call_id: "tool-1",
          sender: "agent",
          action: "Shell",
          description: "Run command",
        },
      },
    ]);

    const resolved = reduceUIStreamEventToDisplay(requested.state, {
      type: "ApprovalRequestResolved",
      payload: { request_id: 0, response: "approve" },
    });

    expect(resolved.state.pendingApprovals).toEqual([]);
  });
});

describe("reduceUIStreamEventToDisplay subagent status", () => {
  it("forwards nested StatusUpdate as a shared UpdateStatus effect", () => {
    const { state, effects } = reduceAll([
      { type: "TurnBegin", payload: { user_input: "delegate" } },
      {
        type: "ToolCall",
        payload: {
          id: "task-1",
          type: "function",
          function: { name: "Task", arguments: "{\"prompt\":\"inspect\"}" },
        },
      },
      {
        type: "SubagentEvent",
        payload: {
          task_tool_call_id: "task-1",
          event: {
            type: "StatusUpdate",
            payload: {
              token_usage: { input_other: 1, output: 2, input_cache_read: 3, input_cache_creation: 4 },
            },
          },
        },
      } as unknown as UIStreamEvent,
    ]);

    const parent = state.messages[1]?.steps?.[0]?.parts[0];
    expect(parent?.type).toBe("tool-call");
    expect(parent && parent.type === "tool-call" ? parent.children?.[0]?.parts : undefined).toContainEqual({
      type: "status",
      status: {
        contextUsage: null,
        contextTokens: null,
        maxContextTokens: null,
        tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        messageId: null,
      },
    });
    expect(effects).toContainEqual({
      type: "UpdateStatus",
      status: {
        contextUsage: null,
        contextTokens: null,
        maxContextTokens: null,
        tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        messageId: null,
      },
    });
  });
});

describe("ACP legacy fixture bridge to shared display model", () => {
  it("bridges ACP message fixtures into shared message and step parts", () => {
    const { state } = reduceLegacyEvents([
      ...translateSessionUpdateFixture(userMessage as { params: AcpSessionNotification; options?: AcpTranslateOptions }),
      ...translateSessionUpdateFixture(agentMessage as { params: AcpSessionNotification }),
    ]);

    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(state.messages[1]?.steps?.[0]?.parts).toEqual([{ type: "text", text: "Hi" }]);
    expect(state.isStreaming).toBe(true);
  });

  it("bridges ACP tool lifecycle fixtures into shared tool display parts and file effects", () => {
    const translator = new AcpLegacyEventTranslator();
    const events = toolCallLifecycle.params.updates.flatMap(
      (notification) => translator.sessionUpdateToEvents(notification as AcpSessionNotification) as UIStreamEvent[],
    );

    const { state, effects } = reduceLegacyEvents(events);

    expect(state.messages[0]?.steps?.[0]?.parts).toMatchObject([
      {
        type: "tool-call",
        id: "tool-1",
        name: "Shell",
        argumentsText: "pnpm test --runInBand",
        status: "success",
        resultText: "done",
        displayBlocks: [
          { type: "brief", text: "done" },
          { type: "diff", path: "src/index.ts", oldText: "a", newText: "b" },
        ],
      },
    ]);
    expect(effects).toContainEqual({ type: "TrackFiles", paths: ["src/index.ts"] });
  });

  it("bridges ACP permission fixtures into shared pending approvals", () => {
    const translator = new AcpLegacyEventTranslator();
    const request = translator.permissionRequestToEvent(
      permissionNumericId.id,
      permissionNumericId.params as AcpPermissionRequest,
    ) as UIStreamEvent;

    const requested = reduceLegacyEvents([request]);
    const resolved = reduceUIStreamEventToDisplay(requested.state, {
      type: "ApprovalRequestResolved",
      payload: { request_id: permissionNumericId.id, response: { optionId: "approve_once" } },
    } as unknown as UIStreamEvent);

    expect(requested.state.pendingApprovals).toMatchObject([
      {
        type: "approval",
        requestId: 0,
        toolCallId: "perm-1",
        displayBlocks: [{ type: "diff", path: "README.md", oldText: "old", newText: "new" }],
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow" },
          { optionId: "reject", name: "Reject", kind: "deny" },
        ],
      },
    ]);
    expect(requested.effects).toContainEqual({ type: "OpenApproval", request: requested.state.pendingApprovals[0] });
    expect(resolved.state.pendingApprovals).toEqual([]);
  });

  it("keeps rich approval display blocks when adapting legacy VS Code events", () => {
    const { state } = reduceAll([
      {
        type: "ApprovalRequest",
        payload: {
          id: "approval-rich",
          tool_call_id: "tool-rich",
          sender: "Kimi",
          action: "request permission",
          description: "Run tests and inspect file",
          display: [
            { type: "command", language: "bash", command: "pnpm test", cwd: "/repo", description: "Run tests" },
            { type: "file-op", operation: "read", path: "README.md", detail: "Inspect docs" },
            { type: "background-task", task_id: "task-1", kind: "shell", status: "running", description: "Run tests" },
          ],
        },
      } as unknown as UIStreamEvent,
    ]);

    expect(state.pendingApprovals[0]?.displayBlocks).toEqual([
      { type: "command", language: "bash", command: "pnpm test", cwd: "/repo", description: "Run tests" },
      { type: "file-op", operation: "read", path: "README.md", detail: "Inspect docs" },
      { type: "background-task", taskId: "task-1", kind: "shell", status: "running", description: "Run tests" },
    ]);
  });

  it("bridges ACP available command fixtures into shared command effects", () => {
    const { state, effects } = reduceLegacyEvents(
      translateSessionUpdateFixture(availableCommands as { params: AcpSessionNotification }),
    );

    expect(state.availableCommands).toEqual([{ name: "clear", description: "Clear" }]);
    expect(effects).toContainEqual({ type: "UpdateAvailableCommands", commands: [{ name: "clear", description: "Clear" }] });
  });

  it("bridges ACP thought, plan, and usage fixtures into shared reasoning, plan, and status state", () => {
    const { state, effects } = reduceLegacyEvents([
      ...translateSessionUpdateFixture(userMessage as { params: AcpSessionNotification; options?: AcpTranslateOptions }),
      ...translateSessionUpdateFixture(agentThought as { params: AcpSessionNotification }),
      ...translateSessionUpdateFixture(plan as { params: AcpSessionNotification }),
      ...translateSessionUpdateFixture(usageUpdate as { params: AcpSessionNotification }),
    ]);

    expect(state.plan).toEqual({
      entries: [
        { content: "One", status: "pending" },
        { content: "Two", status: "in_progress", priority: "high" },
      ],
    });
    expect(state.status).toMatchObject({
      contextUsage: 0.0625,
      contextTokens: 12500,
      maxContextTokens: 200000,
      tokenUsage: { inputOther: 1000, output: 500, inputCacheRead: 100, inputCacheCreation: 50 },
    });
    expect(state.activeTokenUsage).toEqual({ inputOther: 1000, output: 500, inputCacheRead: 100, inputCacheCreation: 50 });
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: "thinking", text: "Think" });
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: "status", status: state.status });
    expect(effects).toContainEqual({ type: "UpdateStatus", status: state.status! });
  });

  it("bridges Kimi compaction and interruption fixtures into shared terminal display state", () => {
    const compacted = reduceLegacyEvents([
      ...translateSessionUpdateFixture(userMessage as { params: AcpSessionNotification; options?: AcpTranslateOptions }),
      ...translateExtensionFixture(compactionStarted.method, compactionStarted.params),
      ...translateExtensionFixture(compactionCompleted.method, compactionCompleted.params),
    ]);

    expect(compacted.state.isCompacting).toBe(false);
    expect(compacted.state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: "compaction",
      status: "running",
      trigger: "manual",
      instruction: "Keep important facts",
    });
    expect(compacted.state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: "compaction",
      status: "completed",
      trigger: "manual",
      instruction: "Keep important facts",
      summary: "Compacted context",
      compactedCount: 12,
      tokensBefore: 12000,
      tokensAfter: 3000,
      message: "Compaction complete",
    });

    const interrupted = reduceLegacyEvents([
      ...translateSessionUpdateFixture(userMessage as { params: AcpSessionNotification; options?: AcpTranslateOptions }),
      ...translateExtensionFixture(stepInterrupted.method, stepInterrupted.params),
    ]);

    expect(interrupted.state.isStreaming).toBe(false);
    expect(interrupted.state.messages[1]?.status).toBe("interrupted");
    expect(interrupted.state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: "interrupt" });
  });

  it("keeps unknown ACP session updates as a shared display no-op", () => {
    const { state, effects } = reduceLegacyEvents(
      translateSessionUpdateFixture(unknownSessionUpdate as { params: AcpSessionNotification }),
    );

    expect(state).toEqual(createInitialDisplayState());
    expect(effects).toEqual([]);
  });

  it("bridges Kimi subagent fixtures into nested shared tool children", () => {
    const translator = new AcpLegacyEventTranslator();
    const parentToolCallId = subagentChildToolCall.params.parentToolCallId;
    const seeded = reduceLegacyEvents([
      {
        type: "ToolCall",
        payload: {
          id: parentToolCallId,
          type: "function",
          function: { name: "Task", arguments: "{\"prompt\":\"inspect\"}" },
        },
      },
    ]);
    const childEvents = translator.extensionNotificationToEvents(
      subagentChildToolCall.method,
      subagentChildToolCall.params,
    ) as UIStreamEvent[];
    const { state } = childEvents.reduce(
      (reduction, event) => {
        const next = reduceUIStreamEventToDisplay(reduction.state, event);
        return { state: next.state, effects: [...reduction.effects, ...next.effects] };
      },
      { state: seeded.state, effects: [] as ReturnType<typeof reduceLegacyEvents>["effects"] },
    );

    expect(state.messages[0]?.steps?.[0]?.parts).toMatchObject([
      {
        type: "tool-call",
        id: parentToolCallId,
        children: [
          {
            parts: [
              {
                type: "tool-call",
                id: "99:child-tool-1",
                name: "Read",
                argumentsText: "{\"path\":\"README.md\"}",
              },
            ],
          },
        ],
      },
    ]);
  });
});
