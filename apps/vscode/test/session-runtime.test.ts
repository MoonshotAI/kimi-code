/**
 * Scenario: one VS Code session runtime adapts the public Node SDK session for one or more Webviews.
 * Responsibilities: prompt conversion, event/terminal delivery, reverse RPC, cancellation, and baseline capture.
 * Wiring: SessionRuntime is real; a small in-memory Session implements only the public SDK boundary.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/session-runtime.test.ts
 */

import type {
  ApprovalHandler,
  ApprovalRequest,
  Event,
  JsonObject,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  QuestionRequest,
  Session,
  SessionSummary,
} from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it } from "vitest";

import { Events } from "../shared/bridge";
import type { LegacyApprovalFlags } from "../src/runtime/legacy-approval";
import { SessionRuntime } from "../src/runtime/session-runtime";

interface BroadcastRecord {
  readonly event: string;
  readonly data: unknown;
  readonly webviewId?: string;
}

interface BaselineRecord {
  readonly session: Pick<SessionSummary, "id" | "workDir" | "metadata">;
  readonly filePath: string;
  readonly webviewIds: readonly string[];
}

interface FakeSessionBoundary {
  readonly session: Session;
  readonly promptInputs: Array<string | PromptInput>;
  readonly steerInputs: Array<string | PromptInput>;
  readonly handlerInstallations: { approval: number; question: number };
  readonly metadataUpdates: JsonObject[];
  readonly setPermissions: PermissionMode[];
  readonly subscriptionCount: () => number;
  readonly cancelCount: () => number;
  readonly cancelCompactionCount: () => number;
  readonly closeCount: () => number;
  emit(event: Event): void;
  rejectNextPrompt(error: Error): void;
  rejectNextMetadataUpdate(error: Error): void;
  requestApproval(request: ApprovalRequest): Promise<Awaited<ReturnType<ApprovalHandler>>>;
  requestQuestion(request: QuestionRequest): Promise<Awaited<ReturnType<QuestionHandler>>>;
}

const DEFAULT_LEGACY_APPROVAL: LegacyApprovalFlags = { yolo: false, afk: false };

function createFakeSession(): FakeSessionBoundary {
  const listeners = new Set<(event: Event) => void>();
  const promptInputs: Array<string | PromptInput> = [];
  const steerInputs: Array<string | PromptInput> = [];
  const handlerInstallations = { approval: 0, question: 0 };
  const metadataUpdates: JsonObject[] = [];
  const setPermissions: PermissionMode[] = [];
  let approvalHandler: ApprovalHandler | undefined;
  let questionHandler: QuestionHandler | undefined;
  let nextPromptError: Error | undefined;
  let nextMetadataError: Error | undefined;
  let subscriptions = 0;
  let cancellations = 0;
  let compactionCancellations = 0;
  let closes = 0;
  let permission: PermissionMode = "manual";

  const summary: SessionSummary = {
    id: "session-1",
    workDir: "/workspace",
    sessionDir: "/home/sessions/session-1",
    createdAt: 1,
    updatedAt: 2,
    metadata: { source: "vscode-test" },
  };

  const session = {
    id: summary.id,
    workDir: summary.workDir,
    summary,
    setApprovalHandler(handler: ApprovalHandler | undefined) {
      approvalHandler = handler;
      if (handler !== undefined) handlerInstallations.approval += 1;
    },
    setQuestionHandler(handler: QuestionHandler | undefined) {
      questionHandler = handler;
      if (handler !== undefined) handlerInstallations.question += 1;
    },
    onEvent(listener: (event: Event) => void) {
      subscriptions += 1;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(input: string | PromptInput) {
      promptInputs.push(input);
      if (nextPromptError !== undefined) {
        const error = nextPromptError;
        nextPromptError = undefined;
        throw error;
      }
    },
    async steer(input: string | PromptInput) {
      steerInputs.push(input);
    },
    async cancel() {
      cancellations += 1;
    },
    async cancelCompaction() {
      compactionCancellations += 1;
    },
    async getStatus() {
      return {
        thinkingEffort: "off",
        permission,
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 128_000,
        contextUsage: 0,
      };
    },
    async setPermission(mode: PermissionMode) {
      permission = mode;
      setPermissions.push(mode);
    },
    async updateMetadata(patch: JsonObject) {
      if (nextMetadataError !== undefined) {
        const error = nextMetadataError;
        nextMetadataError = undefined;
        throw error;
      }
      metadataUpdates.push(patch);
    },
    async close() {
      closes += 1;
    },
  } as unknown as Session;

  return {
    session,
    promptInputs,
    steerInputs,
    handlerInstallations,
    metadataUpdates,
    setPermissions,
    subscriptionCount: () => subscriptions,
    cancelCount: () => cancellations,
    cancelCompactionCount: () => compactionCancellations,
    closeCount: () => closes,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    rejectNextPrompt(error) {
      nextPromptError = error;
    },
    rejectNextMetadataUpdate(error) {
      nextMetadataError = error;
    },
    async requestApproval(request) {
      if (approvalHandler === undefined) throw new Error("Approval handler is unavailable");
      return approvalHandler(request);
    },
    async requestQuestion(request) {
      if (questionHandler === undefined) throw new Error("Question handler is unavailable");
      return questionHandler(request);
    },
  };
}

function createRuntime(legacyApproval = DEFAULT_LEGACY_APPROVAL) {
  const sdk = createFakeSession();
  const broadcasts: BroadcastRecord[] = [];
  const baselines: BaselineRecord[] = [];
  const runtime = new SessionRuntime({
    session: sdk.session,
    legacyApproval,
    broadcast: (event, data, webviewId) => broadcasts.push({ event, data, webviewId }),
    captureBaseline: (session, filePath, webviewIds) => {
      baselines.push({ session, filePath, webviewIds });
    },
    log: () => undefined,
  });
  runtime.subscribe("view-1");
  return { runtime, sdk, broadcasts, baselines };
}

function streamData(records: readonly BroadcastRecord[]): unknown[] {
  return records.filter((record) => record.event === Events.StreamEvent).map((record) => record.data);
}

function turnStarted(): Event {
  return {
    type: "turn.started",
    sessionId: "session-1",
    agentId: "main",
    turnId: 7,
    origin: { kind: "user" },
  };
}

function turnEnded(
  reason: "completed" | "cancelled" | "failed",
  error?: Extract<Event, { type: "turn.ended" }>["error"],
): Event {
  return {
    type: "turn.ended",
    sessionId: "session-1",
    agentId: "main",
    turnId: 7,
    reason,
    error,
  };
}

describe("session runtime (adapts one SDK session for subscribed Webviews)", () => {
  it("renders a host-only command without making it a forkable core turn", () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.beginHostAction("/clear");
    runtime.emitHostText("The context has been cleared.");
    runtime.completeHostAction();

    expect(streamData(broadcasts)).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: "/clear", forkable: false },
        _sessionId: "session-1",
      },
      { type: "StepBegin", payload: { n: 1 }, _sessionId: "session-1" },
      {
        type: "ContentPart",
        payload: { type: "text", text: "The context has been cleared." },
        _sessionId: "session-1",
      },
      {
        type: "stream_complete",
        result: { status: "finished" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("cancels a long-running host action and ignores its late completion", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    const actionId = runtime.beginHostAction("/init");

    await runtime.cancel();
    runtime.emitHostText("AGENTS.md has been generated.", actionId);
    runtime.completeHostAction("finished", actionId);

    expect(sdk.cancelCount()).toBe(1);
    expect(sdk.cancelCompactionCount()).toBe(1);
    expect(streamData(broadcasts)).toContainEqual({
      type: "stream_complete",
      result: { status: "cancelled" },
      _sessionId: "session-1",
    });
    expect(JSON.stringify(streamData(broadcasts))).not.toContain("has been generated");
  });

  it("does not let a cancelled action finish a newer host command", async () => {
    const { runtime, broadcasts } = createRuntime();
    const initAction = runtime.beginHostAction("/init");
    await runtime.cancel();
    const clearAction = runtime.beginHostAction("/clear");

    runtime.emitHostText("late init result", initAction);
    runtime.completeHostAction("finished", initAction);

    expect(runtime.isBusy).toBe(true);
    runtime.emitHostText("The context has been cleared.", clearAction);
    runtime.completeHostAction("finished", clearAction);
    expect(runtime.isBusy).toBe(false);
    expect(JSON.stringify(streamData(broadcasts))).not.toContain("late init result");
  });

  it("waits for the cancelled turn to settle before running an exclusive operation", async () => {
    const { runtime, sdk } = createRuntime();
    const prompt = runtime.prompt("keep working");
    sdk.emit(turnStarted());
    let operationStarted = false;

    const operation = runtime.runExclusiveAfterCancelling(async () => {
      operationStarted = true;
      return "forked";
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sdk.cancelCount()).toBe(1);
    expect(operationStarted).toBe(false);
    expect(runtime.isBusy).toBe(true);

    sdk.emit(turnEnded("cancelled"));

    await expect(prompt).resolves.toEqual({ status: "cancelled" });
    await expect(operation).resolves.toBe("forked");
    expect(operationStarted).toBe(true);
    expect(runtime.isBusy).toBe(false);
  });

  it("keeps a public turn action attached to its original slash input", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();

    const result = runtime.runTurnAction("/skill:review carefully", async () => {
      sdk.emit(turnStarted());
      sdk.emit(turnEnded("completed"));
    });

    await expect(result).resolves.toEqual({ status: "finished" });
    expect(streamData(broadcasts)).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: "/skill:review carefully" },
      _sessionId: "session-1",
    });
  });

  it("converts legacy media keys when a prompt crosses the SDK boundary", async () => {
    const { runtime, sdk } = createRuntime();
    const completion = runtime.prompt([
      { type: "text", text: "Describe these files" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA", id: "image-1" } },
      { type: "video_url", video_url: { url: "file:///workspace/demo.mp4", id: "video-1" } },
    ]);

    sdk.emit(turnStarted());
    sdk.emit(turnEnded("completed"));
    await completion;

    expect(sdk.promptInputs).toEqual([
      [
        { type: "text", text: "Describe these files" },
        { type: "image_url", imageUrl: { url: "data:image/png;base64,AA", id: "image-1" } },
        { type: "video_url", videoUrl: { url: "file:///workspace/demo.mp4", id: "video-1" } },
      ],
    ]);
  });

  it("broadcasts assistant text when the SDK streams a text delta", () => {
    const { sdk, broadcasts } = createRuntime();

    sdk.emit({
      type: "assistant.delta",
      sessionId: "session-1",
      agentId: "main",
      turnId: 7,
      delta: "Implemented",
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ContentPart",
      payload: { type: "text", text: "Implemented" },
      _sessionId: "session-1",
    });
  });

  it("broadcasts model thinking when the SDK streams a thinking delta", () => {
    const { sdk, broadcasts } = createRuntime();

    sdk.emit({
      type: "thinking.delta",
      sessionId: "session-1",
      agentId: "main",
      turnId: 7,
      delta: "Checking the edge case",
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ContentPart",
      payload: { type: "think", think: "Checking the edge case" },
      _sessionId: "session-1",
    });
  });

  it("broadcasts a legacy tool call when an SDK tool starts", () => {
    const { sdk, broadcasts } = createRuntime();

    sdk.emit({
      type: "tool.call.started",
      sessionId: "session-1",
      agentId: "main",
      turnId: 7,
      toolCallId: "tool-1",
      name: "Read",
      args: { path: "src/index.ts" },
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "tool-1",
        function: { name: "ReadFile", arguments: '{"path":"src/index.ts"}' },
      },
      _sessionId: "session-1",
    });
  });

  it.each([
    ["completed", "finished"],
    ["cancelled", "cancelled"],
  ] as const)(
    "emits one stream completion when a turn ends as %s",
    async (reason, expectedStatus) => {
      const { runtime, sdk, broadcasts } = createRuntime();
      const completion = runtime.prompt("hello");
      sdk.emit(turnStarted());

      sdk.emit(turnEnded(reason));
      sdk.emit(turnEnded(reason));

      await expect(completion).resolves.toEqual({ status: expectedStatus });
      expect(
        streamData(broadcasts).filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "stream_complete",
        ),
      ).toEqual([
        {
          type: "stream_complete",
          result: { status: expectedStatus },
          _sessionId: "session-1",
        },
      ]);
    },
  );

  it("emits one error when a failed turn terminal is repeated", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    const completion = runtime.prompt("hello");
    const error = {
      code: "provider.api_error" as const,
      message: "Provider rejected the request",
      retryable: true,
    };
    sdk.emit(turnStarted());

    sdk.emit(turnEnded("failed", error));
    sdk.emit(turnEnded("failed", error));

    await expect(completion).resolves.toEqual({ status: "failed" });
    expect(
      streamData(broadcasts).filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "error",
      ),
    ).toHaveLength(1);
  });

  it("suppresses the trailing SDK error when a failed terminal already reported the same error", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    const completion = runtime.prompt("hello");
    const error = {
      code: "provider.api_error" as const,
      message: "Provider rejected the request",
      retryable: true,
    };
    sdk.emit(turnStarted());

    sdk.emit(turnEnded("failed", error));
    sdk.emit({
      type: "error",
      sessionId: "session-1",
      agentId: "main",
      ...error,
    });

    await completion;
    expect(
      streamData(broadcasts).filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "error",
      ),
    ).toHaveLength(1);
  });

  it("reports a preflight error when SDK prompt setup throws before turn start", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    sdk.rejectNextPrompt(new Error("Unable to initialize provider"));

    await expect(runtime.prompt("hello")).resolves.toEqual({ status: "failed" });

    expect(streamData(broadcasts)).toContainEqual({
      type: "error",
      code: "internal",
      message: "Internal error occurred.",
      detail: "Unable to initialize provider",
      phase: "preflight",
      _sessionId: "session-1",
    });
  });

  it("requests SDK cancellation when the active response is stopped", async () => {
    const { runtime, sdk } = createRuntime();
    void runtime.prompt("hello");

    await runtime.cancel();

    expect(sdk.cancelCount()).toBe(1);
  });

  it("still reaches the SDK cancel when the host lost track of active work", async () => {
    const { runtime, sdk } = createRuntime();

    await runtime.cancel();

    expect(sdk.cancelCount()).toBe(1);
  });

  it("converts legacy media keys when steering an active response", async () => {
    const { runtime, sdk } = createRuntime();
    void runtime.prompt("hello");

    await runtime.steer([
      { type: "text", text: "Use this instead" },
      { type: "image_url", image_url: { url: "file:///workspace/new.png" } },
    ]);

    expect(sdk.steerInputs).toEqual([
      [
        { type: "text", text: "Use this instead" },
        { type: "image_url", imageUrl: { url: "file:///workspace/new.png" } },
      ],
    ]);
  });

  it("echoes a successful steer into the subscribed Webview", async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.subscribe("view-a");

    await runtime.steer("Use this instead");

    expect(streamData(broadcasts)).toContainEqual({
      type: "SteerInput",
      payload: { user_input: "Use this instead" },
      _sessionId: "session-1",
    });
  });

  it.each([
    ["approve", { decision: "approved" }],
    ["approve_for_session", { decision: "approved", scope: "session" }],
    ["reject", { decision: "rejected" }],
  ] as const)("resolves SDK approval when the Webview responds with %s", async (response, expected) => {
    const { runtime, sdk, broadcasts } = createRuntime();
    const pending = sdk.requestApproval({
      toolCallId: "tool-1",
      toolName: "Bash",
      action: "Run command",
      display: { kind: "command", command: "pnpm test" },
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "ApprovalRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondApproval(request.payload.id, response)).toBe(true);
    await expect(pending).resolves.toEqual(expected);
  });

  it("forwards SDK approval requests to the Webview in legacy yolo mode", async () => {
    const { runtime, sdk, broadcasts } = createRuntime({ yolo: true, afk: false });
    const pending = sdk.requestApproval({
      toolCallId: "tool-yolo",
      toolName: "Bash",
      action: "Run command",
      display: { kind: "command", command: "pnpm test" },
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "ApprovalRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondApproval(request.payload.id, "approve")).toBe(true);
    await expect(pending).resolves.toEqual({ decision: "approved" });
  });

  it("restores core permission when a legacy flag cannot be persisted", async () => {
    const { runtime, sdk } = createRuntime();
    sdk.rejectNextMetadataUpdate(new Error("state is read-only"));

    await expect(runtime.toggleLegacyApproval("afk")).rejects.toThrow("state is read-only");

    expect(sdk.setPermissions).toEqual(["auto", "manual"]);
    expect(runtime.legacyApprovalFlags).toEqual({ yolo: false, afk: false });
  });

  it("resolves an SDK question when the Webview submits answers", async () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    const pending = sdk.requestQuestion({
      toolCallId: "question-1",
      questions: [
        {
          question: "Choose a target",
          header: "Target",
          options: [{ label: "Tests", description: "Run focused tests" }],
          multiSelect: false,
        },
      ],
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "QuestionRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondQuestion(request.payload.id, { "Choose a target": "Tests" })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { "Choose a target": "Tests" } });
  });

  it("keeps SDK questions interactive in legacy yolo mode", async () => {
    const { runtime, sdk, broadcasts } = createRuntime({ yolo: true, afk: false });
    const pending = sdk.requestQuestion({
      toolCallId: "question-yolo",
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }],
          multiSelect: false,
        },
      ],
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "QuestionRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondQuestion(request.payload.id, { "Continue?": "Yes" })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { "Continue?": "Yes" } });
  });

  it("cancels a pending SDK approval when the session closes", async () => {
    const { runtime, sdk } = createRuntime();
    const pending = sdk.requestApproval({
      toolCallId: "tool-1",
      toolName: "Bash",
      action: "Run command",
      display: { kind: "command", command: "pnpm test" },
    });

    await runtime.close();

    await expect(pending).resolves.toEqual({
      decision: "cancelled",
      feedback: "Session closed",
    });
  });

  it("cancels a pending SDK question when the session closes", async () => {
    const { runtime, sdk } = createRuntime();
    const pending = sdk.requestQuestion({
      questions: [
        { question: "Continue?", options: [{ label: "Yes" }], multiSelect: false },
      ],
    });

    await runtime.close();

    await expect(pending).resolves.toBeNull();
  });

  it("fans out one SDK subscription to every Webview attached to the session", () => {
    const { runtime, sdk, broadcasts } = createRuntime();
    runtime.subscribe("view-2");

    sdk.emit({
      type: "assistant.delta",
      sessionId: "session-1",
      agentId: "main",
      turnId: 7,
      delta: "Shared update",
    });

    expect(sdk.subscriptionCount()).toBe(1);
    expect(sdk.handlerInstallations).toEqual({ approval: 1, question: 1 });
    expect(broadcasts.map((record) => record.webviewId)).toEqual(["view-1", "view-2"]);
  });

  it.each(["Write", "Edit"] as const)(
    "captures the original file when %s starts with a path",
    (name) => {
      const { sdk, baselines } = createRuntime();

      sdk.emit({
        type: "tool.call.started",
        sessionId: "session-1",
        agentId: "main",
        turnId: 7,
        toolCallId: "tool-1",
        name,
        args: { path: "src/index.ts" },
      });

      expect(baselines).toEqual([
        {
          session: {
            id: "session-1",
            workDir: "/workspace",
            metadata: { source: "vscode-test" },
          },
          filePath: "src/index.ts",
          webviewIds: ["view-1"],
        },
      ]);
    },
  );

  it.each([
    ["Read", { path: "src/index.ts" }],
    ["Write", {}],
    ["Edit", { path: "" }],
  ] as const)("does not capture a baseline when %s receives non-write input %#", (name, args) => {
    const { sdk, baselines } = createRuntime();

    sdk.emit({
      type: "tool.call.started",
      sessionId: "session-1",
      agentId: "main",
      turnId: 7,
      toolCallId: "tool-1",
      name,
      args,
    });

    expect(baselines).toEqual([]);
  });
});
