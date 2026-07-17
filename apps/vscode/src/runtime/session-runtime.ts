import {
  isKimiError,
  type ContentPart as SdkContentPart,
  type Event,
  type PromptInput,
  type Session,
  type SessionSummary,
} from "@moonshot-ai/kimi-code-sdk";

import type { ContentPart as LegacyContentPart, ApprovalResponse } from "../../shared/legacy-sdk";
import { Events } from "../../shared/bridge";
import { getUserMessage } from "../../shared/errors";
import type { ErrorPhase, UIStreamEvent } from "../../shared/types";
import {
  adaptSdkEvent,
  createEventAdapterState,
  type EventAdapterState,
  type TurnTerminalMetadata,
} from "./event-adapter";
import {
  corePermissionForLegacyApproval,
  legacyApprovalMetadata,
  type LegacyApprovalFlags,
} from "./legacy-approval";
import { ReverseRpcController } from "./reverse-rpc";

export type RuntimeBroadcast = (event: string, data: unknown, webviewId?: string) => void;

export interface SessionRuntimeOptions {
  readonly session: Session;
  readonly legacyApproval: LegacyApprovalFlags;
  readonly broadcast: RuntimeBroadcast;
  readonly captureBaseline: (
    session: Pick<SessionSummary, "id" | "workDir" | "metadata">,
    filePath: string,
    webviewIds: readonly string[],
  ) => void;
  readonly log: (message: string, error?: unknown) => void;
}

interface ActivePrompt {
  readonly input: LegacyContentPart[] | string;
  started: boolean;
  settled: boolean;
  resolve: (result: PromptResult) => void;
}

const ALREADY_GENERATING_MESSAGE = "A response is already being generated for this session.";

export interface PromptResult {
  readonly status: "finished" | "cancelled" | "failed";
}

interface SuppressedError {
  readonly code: string;
  readonly message: string;
}

interface PendingHostCompaction {
  readonly actionId: number;
  readonly resolve: (result: "completed" | "cancelled") => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Owns the one SDK event subscription and reverse-RPC handlers for a session.
 * Any number of Webviews may subscribe without replacing each other's approval
 * handler or duplicating streamed events.
 */
export class SessionRuntime {
  readonly session: Session;

  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: SessionRuntimeOptions["captureBaseline"];
  private readonly log: SessionRuntimeOptions["log"];
  private readonly webviewIds = new Set<string>();
  private readonly reverseRpc: ReverseRpcController;
  private readonly unsubscribe: () => void;
  private adapterState: EventAdapterState = createEventAdapterState();
  private activePrompt: ActivePrompt | undefined;
  private hostActionActive = false;
  private hostActionSequence = 0;
  private activeHostActionId: number | undefined;
  private readonly cancelledHostActions = new Set<number>();
  private pendingHostCompaction: PendingHostCompaction | undefined;
  private readonly activeWorkSettledWaiters = new Set<() => void>();
  private exclusiveActionActive = false;
  private readonly terminalKeys = new Set<string>();
  private suppressedError: SuppressedError | undefined;
  private legacyApproval: LegacyApprovalFlags;
  private closed = false;

  constructor(options: SessionRuntimeOptions) {
    this.session = options.session;
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.log = options.log;
    this.legacyApproval = options.legacyApproval;
    this.reverseRpc = new ReverseRpcController((event) => this.emitStreamEvent(event));

    // Forward every approval request to the user. The engine permission mode
    // (mapped from the legacy flags) already auto-approves what yolo/auto
    // allow internally; anything that reaches this handler is an exception
    // (sensitive file, plan review, ask rule) the user must decide on.
    this.session.setApprovalHandler((request) => this.reverseRpc.requestApproval(request));
    this.session.setQuestionHandler((request) => this.reverseRpc.requestQuestion(request));
    this.unsubscribe = this.session.onEvent((event) => this.onSdkEvent(event));
  }

  get id(): string {
    return this.session.id;
  }

  get summary(): SessionSummary | undefined {
    return this.session.summary;
  }

  get subscribers(): readonly string[] {
    return [...this.webviewIds];
  }

  get isBusy(): boolean {
    return this.hasActiveWork || this.exclusiveActionActive;
  }

  get legacyApprovalFlags(): LegacyApprovalFlags {
    return this.legacyApproval;
  }

  async toggleLegacyApproval(kind: keyof LegacyApprovalFlags): Promise<LegacyApprovalFlags> {
    const next = { ...this.legacyApproval, [kind]: !this.legacyApproval[kind] };
    await this.applyLegacyApproval(next);
    return next;
  }

  async setLegacyYoloMode(enabled: boolean): Promise<void> {
    if (this.legacyApproval.yolo === enabled) return;
    await this.applyLegacyApproval({ ...this.legacyApproval, yolo: enabled });
  }

  subscribe(webviewId: string): void {
    this.ensureOpen();
    this.webviewIds.add(webviewId);
  }

  /**
   * Push the session's current status to a view. Called whenever a view
   * opens or re-enters a session so the display (model, thinking effort,
   * plan mode) matches engine truth instead of the global defaults.
   */
  async announceStatus(webviewId: string): Promise<void> {
    this.ensureOpen();
    const status = await this.session.getStatus();
    if (this.closed || !this.webviewIds.has(webviewId)) return;
    this.broadcast(
      Events.StreamEvent,
      {
        type: "StatusUpdate",
        payload: {
          model: status.model,
          thinking_effort: status.thinkingEffort,
          plan_mode: status.planMode,
        },
        _sessionId: this.id,
      },
      webviewId,
    );
  }

  unsubscribeView(webviewId: string): void {
    this.webviewIds.delete(webviewId);
  }

  async prompt(input: string | LegacyContentPart[]): Promise<PromptResult> {
    return this.runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)));
  }

  async runTurnAction(
    input: string | LegacyContentPart[],
    action: () => Promise<void>,
  ): Promise<PromptResult> {
    this.ensureOpen();
    if (this.isBusy) {
      // A re-entrant turn request must never disturb the active turn — it fails
      // only itself. When a turn or host action is running, its later terminal
      // stream event unlocks every subscribed view, so a non-terminal warning
      // is enough. An exclusive operation (e.g. fork materialization) emits no
      // such terminal event, so reject terminally: the caller's composer must
      // unlock rather than hang until the handshake timeout.
      this.emitError(
        new Error(ALREADY_GENERATING_MESSAGE),
        "runtime",
        { terminal: this.hasActiveWork ? false : undefined },
      );
      return { status: "failed" };
    }

    let resolveCompletion!: (result: PromptResult) => void;
    const completion = new Promise<PromptResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActivePrompt = {
      input,
      started: false,
      settled: false,
      resolve: resolveCompletion,
    };
    this.activePrompt = active;

    try {
      await action();
    } catch (error) {
      // Only settle the prompt this call created. Once the event pipeline or a
      // cancel has settled it, the failure was already reported — settling it
      // again would misreport the active turn and could emit a duplicate error.
      if (!active.settled) {
        this.emitError(error, active.started ? "runtime" : "preflight");
        this.settlePrompt({ status: "failed" });
      }
    }

    return completion;
  }

  beginHostAction(input: string | LegacyContentPart[], forkable = false): number {
    this.ensureOpen();
    if (this.isBusy) {
      throw new Error(ALREADY_GENERATING_MESSAGE);
    }
    const actionId = ++this.hostActionSequence;
    this.hostActionActive = true;
    this.activeHostActionId = actionId;
    this.emitStreamEvent({
      type: "TurnBegin",
      payload: { user_input: input, forkable },
      _sessionId: this.id,
    });
    this.emitStreamEvent({
      type: "StepBegin",
      payload: { n: 1 },
      _sessionId: this.id,
    });
    return actionId;
  }

  emitHostText(text: string, actionId = this.activeHostActionId): void {
    if (!this.hostActionActive || actionId !== this.activeHostActionId || text.length === 0) return;
    this.emitStreamEvent({
      type: "ContentPart",
      payload: { type: "text", text },
      _sessionId: this.id,
    });
  }

  announceSessionStart(model?: string): void {
    this.emitStreamEvent({
      type: "session_start",
      sessionId: this.id,
      ...(model === undefined ? {} : { model }),
      _sessionId: this.id,
    });
  }

  completeHostAction(
    status: "finished" | "cancelled" = "finished",
    actionId = this.activeHostActionId,
  ): void {
    if (!this.hostActionActive || actionId !== this.activeHostActionId) return;
    this.hostActionActive = false;
    this.activeHostActionId = undefined;
    this.emitStreamEvent({
      type: "stream_complete",
      result: { status },
      _sessionId: this.id,
    });
    this.notifyActiveWorkSettled();
  }

  failHostAction(actionId: number): void {
    if (!this.hostActionActive || actionId !== this.activeHostActionId) return;
    this.hostActionActive = false;
    this.activeHostActionId = undefined;
    this.notifyActiveWorkSettled();
  }

  wasHostActionCancelled(actionId: number): boolean {
    return this.cancelledHostActions.has(actionId);
  }

  releaseHostAction(actionId: number): void {
    this.cancelledHostActions.delete(actionId);
  }

  async compactHostAction(actionId: number, instruction?: string): Promise<void> {
    if (!this.hostActionActive || actionId !== this.activeHostActionId) {
      throw new Error("The host action is no longer active.");
    }
    if (this.pendingHostCompaction !== undefined) {
      throw new Error("A context compaction is already running.");
    }

    let resolveCompletion!: (result: "completed" | "cancelled") => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<"completed" | "cancelled">((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.pendingHostCompaction = {
      actionId,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };

    try {
      await this.session.compact(instruction === undefined ? {} : { instruction });
    } catch (error) {
      if (this.pendingHostCompaction?.actionId === actionId) {
        this.pendingHostCompaction = undefined;
        rejectCompletion(error);
      }
    }

    const result = await completion;
    if (result === "cancelled") {
      throw new Error("Context compaction was cancelled.");
    }
  }

  async cancel(): Promise<void> {
    // Always reach the engine, even when the host believes nothing is active.
    // The host-side bookkeeping can drift from engine truth after an abnormal
    // error path; session.cancel() is a harmless no-op when the engine is
    // idle, but it is the only way to recover a turn the host lost track of.
    if (this.closed) return;
    this.reverseRpc.cancelAll("Turn cancelled");
    const cancellingHostAction = this.hostActionActive;
    const hostActionId = this.activeHostActionId;
    if (cancellingHostAction && hostActionId !== undefined) {
      this.cancelledHostActions.add(hostActionId);
      this.completeHostAction("cancelled", hostActionId);
    }
    // A manual compaction is not a model turn, so Session.cancel() alone does
    // not stop it. Calling both public cancellation surfaces is harmless when
    // the other operation is idle and keeps the Stop button correct for both
    // normal turns and host-side slash commands such as /compact and /init.
    const results = await Promise.allSettled([
      this.session.cancel(),
      ...(cancellingHostAction ? [this.session.cancelCompaction()] : []),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  /**
   * Stop any in-flight work, wait for its terminal event, and keep new turns
   * out until the supplied operation finishes. Forking uses this so it reads a
   * fully settled session instead of racing the asynchronous cancel event.
   */
  async runExclusiveAfterCancelling<T>(action: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    if (this.exclusiveActionActive) {
      throw new Error("Another session operation is already in progress.");
    }

    this.exclusiveActionActive = true;
    try {
      const settled = this.waitForActiveWorkToSettle();
      await this.cancel();
      await settled;
      this.ensureOpen();
      return await action();
    } finally {
      this.exclusiveActionActive = false;
    }
  }

  async steer(input: string | LegacyContentPart[]): Promise<void> {
    this.ensureOpen();
    await this.session.steer(toSdkPromptInput(input));
    this.emitStreamEvent({
      type: "SteerInput",
      payload: { user_input: input },
      _sessionId: this.id,
    });
  }

  respondApproval(id: string, response: ApprovalResponse): boolean {
    return this.reverseRpc.respondApproval(id, response);
  }

  respondQuestion(id: string, answers: Record<string, string>): boolean {
    return this.reverseRpc.respondQuestion(id, answers);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingHostCompaction?.reject(new Error("Session closed during context compaction."));
    this.pendingHostCompaction = undefined;
    this.reverseRpc.cancelAll("Session closed");
    this.unsubscribe();
    this.session.setApprovalHandler(undefined);
    this.session.setQuestionHandler(undefined);
    if (this.activePrompt !== undefined || this.hostActionActive) {
      try {
        await this.session.cancel();
      } catch (error) {
        this.log("Failed to cancel the active turn while closing a session", error);
      }
      if (this.activePrompt !== undefined) this.settlePrompt({ status: "cancelled" });
      this.hostActionActive = false;
      this.activeHostActionId = undefined;
      this.notifyActiveWorkSettled();
    }
    this.cancelledHostActions.clear();
    await this.session.close();
    this.webviewIds.clear();
  }

  private async applyLegacyApproval(flags: LegacyApprovalFlags): Promise<void> {
    this.ensureOpen();
    const permission = corePermissionForLegacyApproval(flags);
    const status = await this.session.getStatus();
    const permissionChanged = status.permission !== permission;
    if (permissionChanged) await this.session.setPermission(permission);
    try {
      await this.session.updateMetadata(legacyApprovalMetadata(flags));
    } catch (error) {
      if (permissionChanged) {
        await this.session.setPermission(status.permission).catch((rollbackError: unknown) => {
          this.log("Failed to restore session permission after a metadata error", rollbackError);
        });
      }
      throw error;
    }
    this.legacyApproval = flags;
  }

  private onSdkEvent(event: Event): void {
    if (this.closed) return;

    if (event.type === "compaction.completed" || event.type === "compaction.cancelled") {
      const pending = this.pendingHostCompaction;
      if (pending !== undefined) {
        this.pendingHostCompaction = undefined;
        pending.resolve(event.type === "compaction.completed" ? "completed" : "cancelled");
      }
    }

    if (event.type === "turn.started" && event.agentId === "main" && this.activePrompt !== undefined) {
      this.activePrompt.started = true;
    }

    if (event.type === "tool.call.started") {
      this.captureFileBaseline(event);
    }

    if (event.type === "turn.step.retrying") {
      this.log(
        `Provider retry ${event.nextAttempt}/${event.maxAttempts} in ${event.delayMs}ms`,
        new Error(event.errorMessage),
      );
    }

    if (event.type === "error" && this.consumeSuppressedError(event.code, event.message)) {
      return;
    }

    const pendingInput = this.activePrompt?.input;
    const adapted = adaptSdkEvent(this.adapterState, event, {
      pendingInput,
      errorPhase: this.activePrompt?.started === false ? "preflight" : "runtime",
    });
    this.adapterState = adapted.state;

    if (adapted.terminal !== undefined) {
      this.emitTerminal(adapted.terminal);
      return;
    }

    if (adapted.event !== undefined) {
      // Errors the core reports while the active turn keeps running (they are
      // not followed by a terminal turn.ended) must not look turn-ending to the
      // Webview — otherwise the UI unlocks mid-turn and the next send collides
      // with the still-active prompt.
      const wireEvent =
        adapted.event.type === "error" && this.activePrompt?.started === true
          ? { ...adapted.event, terminal: false as const }
          : adapted.event;
      this.emitStreamEvent(wireEvent);
      if (adapted.event.type === "error" && this.activePrompt !== undefined && !this.activePrompt.started) {
        this.settlePrompt({ status: "failed" });
      }
    }
  }

  private captureFileBaseline(event: Extract<Event, { type: "tool.call.started" }>): void {
    if (event.name !== "Write" && event.name !== "Edit") return;
    if (!isRecord(event.args)) return;
    const filePath = event.args["path"];
    if (typeof filePath !== "string" || filePath.length === 0) return;

    const summary = this.session.summary;
    this.captureBaseline(
      {
        id: this.session.id,
        workDir: this.session.workDir,
        metadata: summary?.metadata,
      },
      filePath,
      this.subscribers,
    );
  }

  private emitTerminal(terminal: TurnTerminalMetadata): void {
    if (this.terminalKeys.has(terminal.key)) return;
    this.terminalKeys.add(terminal.key);

    if (terminal.reason === "completed") {
      this.emitStreamEvent({
        type: "stream_complete",
        result: { status: "finished" },
        _sessionId: terminal.sessionId,
      });
      this.settlePrompt({ status: "finished" });
      return;
    }

    if (terminal.reason === "cancelled") {
      this.reverseRpc.cancelAll("Turn cancelled");
      this.emitStreamEvent({
        type: "stream_complete",
        result: { status: "cancelled" },
        _sessionId: terminal.sessionId,
      });
      this.settlePrompt({ status: "cancelled" });
      return;
    }

    const code = terminal.error?.code ?? `turn.${terminal.reason}`;
    this.reverseRpc.cancelAll("Turn ended");
    const detail = terminal.error?.message ?? `Turn ended with reason: ${terminal.reason}`;
    const message = getUserMessage(code, detail);
    this.log("Session turn failed", new Error(`${code}: ${detail}`));
    this.emitStreamEvent({
      type: "error",
      code,
      message,
      detail,
      phase: "runtime",
      _sessionId: terminal.sessionId,
    });
    if (terminal.error !== undefined) {
      this.suppressedError = { code: terminal.error.code, message: terminal.error.message };
    }
    this.settlePrompt({ status: "failed" });
  }

  private consumeSuppressedError(code: string, message: string): boolean {
    const suppressed = this.suppressedError;
    if (suppressed === undefined) return false;
    this.suppressedError = undefined;
    return suppressed.code === code && suppressed.message === message;
  }

  private emitError(error: unknown, phase: ErrorPhase, options?: { readonly terminal?: boolean }): void {
    const code = isKimiError(error) ? error.code : "internal";
    const detail = error instanceof Error ? error.message : String(error);
    this.log(`Session ${phase} error`, error);
    this.emitStreamEvent({
      type: "error",
      code,
      message: getUserMessage(code, detail),
      detail,
      phase,
      _sessionId: this.session.id,
      terminal: options?.terminal,
    });
  }

  private emitStreamEvent(event: UIStreamEvent | { type: string; payload: unknown }): void {
    for (const webviewId of this.webviewIds) {
      this.broadcast(Events.StreamEvent, event, webviewId);
    }
  }

  private settlePrompt(result: PromptResult): void {
    const active = this.activePrompt;
    if (active === undefined || active.settled) return;
    active.settled = true;
    this.activePrompt = undefined;
    active.resolve(result);
    this.notifyActiveWorkSettled();
  }

  private get hasActiveWork(): boolean {
    return this.activePrompt !== undefined || this.hostActionActive;
  }

  private waitForActiveWorkToSettle(): Promise<void> {
    if (!this.hasActiveWork) return Promise.resolve();
    return new Promise((resolve) => {
      this.activeWorkSettledWaiters.add(resolve);
    });
  }

  private notifyActiveWorkSettled(): void {
    if (this.hasActiveWork) return;
    for (const resolve of this.activeWorkSettledWaiters) resolve();
    this.activeWorkSettledWaiters.clear();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Session is closed.");
  }
}

export function toSdkPromptInput(input: string | LegacyContentPart[]): string | PromptInput {
  if (typeof input === "string") return input;
  const parts: SdkContentPart[] = [];
  for (const part of input) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image_url":
        parts.push({
          type: "image_url",
          imageUrl: {
            url: part.image_url.url,
            ...(part.image_url.id === null || part.image_url.id === undefined ? {} : { id: part.image_url.id }),
          },
        });
        break;
      case "video_url":
        parts.push({
          type: "video_url",
          videoUrl: {
            url: part.video_url.url,
            ...(part.video_url.id === null || part.video_url.id === undefined ? {} : { id: part.video_url.id }),
          },
        });
        break;
      case "audio_url":
      case "think":
        // PromptInput intentionally accepts user text/images/videos only.
        break;
    }
  }
  return parts as PromptInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
