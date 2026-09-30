import { randomUUID } from "node:crypto";

import {
  AgentModelRef,
  MAIN_AGENT_ID,
  type AgentHandle,
  type AgentModelFace,
  type ContentPart as EngineContentPart,
  type MediaSource,
  type SessionRecord,
  type UserMessage,
} from "@moonshot-ai/agent-core";
import type { CertainToken, FacadeToken, Token } from "@moonshot-ai/agent-core/kernel/index";
import {
  CompactionRef,
  PermissionRef,
  PlanRef,
  SessionInitRef,
  SessionTitleRef,
  SkillRef,
  TokenCountingRef,
  type CompactionFace,
  type PermissionFace,
  type PermissionMode,
  type PlanFace,
  type SessionInitFace,
  type SessionTitleFace,
  type SkillFace,
  type TokenCountingFace,
} from "@moonshot-ai/harness-core";
import { isKimiError, type KimiSession } from "@moonshot-ai/kimi-code-sdk";

import type { ContentPart as LegacyContentPart, ApprovalResponse } from "../../shared/legacy-sdk";
import { Events } from "../../shared/bridge";
import { getUserMessage } from "../../shared/errors";
import type { ErrorPhase, UIStreamEvent } from "../../shared/types";
import {
  adaptSdkEvent,
  createEventAdapterState,
  type Event,
  type EventAdapterState,
  type TurnTerminalMetadata,
} from "./event-adapter";
import {
  corePermissionForLegacyApproval,
  legacyApprovalMetadata,
  type LegacyApprovalFlags,
} from "./legacy-approval";
import { ReverseRpcController } from "./reverse-rpc";
import { SessionEventSource } from "./session-event-source";
import type { ContextMessage } from "../utils/session-context";
import { contextMessageFromHistory } from "../utils/session-context";

export type RuntimeBroadcast = (event: string, data: unknown, webviewId?: string) => void;

export interface SessionRuntimeOptions {
  readonly session: KimiSession;
  readonly workDir: string;
  readonly legacyApproval: LegacyApprovalFlags;
  readonly broadcast: RuntimeBroadcast;
  readonly captureBaseline: (
    session: { readonly id: string; readonly workDir: string; readonly metadata?: Readonly<Record<string, unknown>> },
    filePath: string,
    webviewIds: readonly string[],
  ) => void;
  readonly updateMetadata: (
    id: string,
    patch: Record<string, unknown>,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly recreateSession: (
    id: string,
    metadata: Readonly<Record<string, unknown>> | undefined,
  ) => Promise<KimiSession>;
  readonly configDefaults?: () => { readonly model?: string; readonly thinking?: string };
  readonly log: (message: string, error?: unknown) => void;
}

export interface SessionStatusSnapshot {
  readonly model: string | undefined;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
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

export class SessionRuntime {
  private session: KimiSession;
  private main: AgentHandle;
  private eventSource: SessionEventSource;

  readonly workDir: string;

  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: SessionRuntimeOptions["captureBaseline"];
  private readonly updateMetadataDelegate: SessionRuntimeOptions["updateMetadata"];
  private readonly recreateSessionDelegate: SessionRuntimeOptions["recreateSession"];
  private readonly configDefaults: () => { readonly model?: string; readonly thinking?: string };
  private readonly log: SessionRuntimeOptions["log"];
  private readonly webviewIds = new Set<string>();
  private readonly reverseRpc: ReverseRpcController;
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
  private record: SessionRecord | undefined;
  private titleRequested = false;
  private closed = false;

  constructor(options: SessionRuntimeOptions) {
    this.session = options.session;
    this.main = options.session.main;
    this.workDir = options.workDir;
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.updateMetadataDelegate = options.updateMetadata;
    this.recreateSessionDelegate = options.recreateSession;
    this.configDefaults = options.configDefaults ?? (() => ({}));
    this.log = options.log;
    this.legacyApproval = options.legacyApproval;
    this.reverseRpc = new ReverseRpcController((event) => this.emitStreamEvent(event));
    this.reverseRpc.mountSession(this.session);
    this.eventSource = this.createEventSource();
    this.eventSource.start();
  }

  get id(): string {
    return this.session.id;
  }

  get engineSession(): KimiSession {
    return this.session;
  }

  get summary(): { readonly id: string; readonly workDir: string; readonly metadata?: Readonly<Record<string, unknown>> } {
    return {
      id: this.id,
      workDir: this.workDir,
      metadata: this.record?.metadata,
    };
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

  setSessionRecord(record: SessionRecord | undefined): void {
    this.record = record;
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

  async announceStatus(webviewId: string): Promise<void> {
    this.ensureOpen();
    const status = this.getStatus();
    if (this.closed || !this.webviewIds.has(webviewId)) return;
    this.broadcast(
      Events.StreamEvent,
      {
        type: "StatusUpdate",
        payload: {
          model: status.model,
          thinking_effort: status.thinkingEffort,
          plan_mode: status.planMode,
          context_usage: status.contextUsage,
        },
        _sessionId: this.id,
      },
      webviewId,
    );
  }

  unsubscribeView(webviewId: string): void {
    this.webviewIds.delete(webviewId);
  }

  getStatus(): SessionStatusSnapshot {
    const model = this.resolveOptional<AgentModelFace>(AgentModelRef, "agent");
    const permission = this.resolveOptional<PermissionFace>(PermissionRef, "agent");
    const plan = this.resolveOptional<PlanFace>(PlanRef, "agent");
    const tokenCounting = this.resolveOptional<TokenCountingFace>(TokenCountingRef, "agent");
    const binding = model?.current.value;
    const defaults = this.configDefaults();
    const contextTokens = tokenCounting?.status.value ?? 0;
    const maxContextTokens = this.main.model?.spec.maxContextSize ?? 0;
    return {
      model: binding?.alias ?? defaults.model,
      thinkingEffort: binding?.thinking ?? defaults.thinking ?? "off",
      permission: permission?.state.value.mode ?? corePermissionForLegacyApproval(this.legacyApproval),
      planMode: plan?.state.value.active ?? false,
      contextTokens,
      maxContextTokens,
      contextUsage: maxContextTokens > 0 ? contextTokens / maxContextTokens : 0,
    };
  }

  async setModel(model: string): Promise<void> {
    await this.resolveRequired<AgentModelFace>(AgentModelRef, "agent").setModel(model);
  }

  async setThinking(effort: string): Promise<void> {
    await this.resolveRequired<AgentModelFace>(AgentModelRef, "agent").setThinking(effort);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    const plan = this.resolveRequired<PlanFace>(PlanRef, "agent");
    if (plan.state.value.active === enabled) return;
    if (enabled) {
      await plan.enter(undefined, true);
      return;
    }
    await plan.cancel();
  }

  async getPlan(): Promise<{ readonly content: string; readonly path: string } | null> {
    const plan = this.resolveOptional<PlanFace>(PlanRef, "agent");
    const status = await plan?.status();
    if (status === null || status === undefined) return null;
    return { content: status.content, path: status.path };
  }

  async clearPlan(): Promise<void> {
    await this.resolveRequired<PlanFace>(PlanRef, "agent").clear();
  }

  async init(): Promise<void> {
    await this.resolveRequired<SessionInitFace>(SessionInitRef, "session").generateAgentsMd();
  }

  async activateSkill(name: string, args?: string): Promise<void> {
    await this.resolveRequired<SkillFace>(SkillRef, "agent").activate({ name, args });
  }

  getContext(): { readonly history: ContextMessage[]; readonly tokenCount: number } {
    const store = this.session.handle.stores.get(MAIN_AGENT_ID);
    const history = store?.getState().history ?? [];
    const tokenCounting = this.resolveOptional<TokenCountingFace>(TokenCountingRef, "agent");
    return {
      history: history.map(contextMessageFromHistory),
      tokenCount: tokenCounting?.status.value ?? 0,
    };
  }

  async importContext(content: string, source: string): Promise<void> {
    this.ensureOpen();
    const store = this.session.handle.stores.get(MAIN_AGENT_ID);
    if (store === undefined) throw new Error("Session history is unavailable.");
    const text = `<imported_context source="${escapeXml(source)}">\n${content}\n</imported_context>`;
    await store.dispatch({
      type: "message.appended",
      message: {
        message: { role: "user", content: [{ type: "text", text }] },
        meta: { origin: { kind: "user" } },
      },
    });
  }

  async clearContext(): Promise<void> {
    this.ensureOpen();
    const metadata = this.record?.metadata;
    this.eventSource.close();
    this.reverseRpc.unmountSession();
    await this.session.close().catch((error: unknown) => {
      this.log("Failed to close the session before clearing its context", error);
    });
    const fresh = await this.recreateSessionDelegate(this.id, metadata);
    this.session = fresh;
    this.main = fresh.main;
    this.adapterState = createEventAdapterState();
    this.terminalKeys.clear();
    this.reverseRpc.mountSession(fresh);
    this.eventSource = this.createEventSource();
    this.eventSource.start();
    await this.applyPermissionMode(corePermissionForLegacyApproval(this.legacyApproval));
  }

  async prompt(input: string | LegacyContentPart[]): Promise<PromptResult> {
    return this.runTurnAction(input, async () => {
      const ack = this.main.submit(
        toEngineUserMessage(input),
        { origin: { kind: "user" }, tracked: true, promptId: randomUUID() },
      );
      if (ack === undefined) throw new Error("Failed to send: the agent is not running.");
    });
  }

  async runTurnAction(
    input: string | LegacyContentPart[],
    action: () => Promise<void>,
  ): Promise<PromptResult> {
    this.ensureOpen();
    if (this.isBusy) {
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
    const compaction = this.resolveOptional<CompactionFace>(CompactionRef, "agent");
    if (compaction === undefined) {
      throw new Error("Context compaction is not available in this session.");
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
      await compaction.compact(instruction);
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
    if (this.closed) return;
    this.reverseRpc.cancelAll("Turn cancelled");
    const cancellingHostAction = this.hostActionActive;
    const hostActionId = this.activeHostActionId;
    if (cancellingHostAction && hostActionId !== undefined) {
      this.cancelledHostActions.add(hostActionId);
      this.completeHostAction("cancelled", hostActionId);
    }
    const sessionInit = this.resolveOptional<SessionInitFace>(SessionInitRef, "session");
    sessionInit?.cancelInit("Turn cancelled");
    const compaction = this.resolveOptional<CompactionFace>(CompactionRef, "agent");
    if (cancellingHostAction) compaction?.cancel();
    this.main.abort("Turn cancelled");
  }

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
    const promptId = randomUUID();
    const ack = this.main.submit(
      toEngineUserMessage(input),
      { origin: { kind: "user" }, tracked: true, promptId },
    );
    if (ack === undefined) throw new Error("Failed to steer: the agent is not running.");
    this.main.steer([promptId]);
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
    this.reverseRpc.unmountSession();
    this.eventSource.close();
    if (this.activePrompt !== undefined || this.hostActionActive) {
      try {
        this.main.abort("Session closed");
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

  private createEventSource(): SessionEventSource {
    return new SessionEventSource({
      session: this.session,
      workDir: this.workDir,
      maxContextTokens: () => this.main.model?.spec.maxContextSize,
      emit: (event) => this.onSdkEvent(event),
      onSessionMeta: (meta) => {
        this.record = meta;
      },
      onMainRebound: (main) => {
        this.main = main;
      },
      log: this.log,
    });
  }

  private resolveOptional<T>(token: Token<T>, tier: "agent" | "session"): T | undefined {
    const handle = tier === "agent" ? this.main : this.session.handle;
    if (token.kind === "facade") return handle.resolve(token as FacadeToken<T>);
    try {
      return handle.resolve(token as CertainToken<T>);
    } catch {
      return undefined;
    }
  }

  private resolveRequired<T>(token: Token<T>, tier: "agent" | "session"): T {
    const resolved = this.resolveOptional<T>(token, tier);
    if (resolved === undefined) {
      throw new Error("This capability is not available in the session.");
    }
    return resolved;
  }

  private async applyLegacyApproval(flags: LegacyApprovalFlags): Promise<void> {
    this.ensureOpen();
    const permission = corePermissionForLegacyApproval(flags);
    const face = this.resolveOptional<PermissionFace>(PermissionRef, "agent");
    const previous = face?.state.value.mode;
    const permissionChanged = previous !== undefined && previous !== permission;
    if (face !== undefined && previous !== permission) {
      await face.setModeAndBroadcast(permission);
    }
    try {
      await this.updateMetadata(legacyApprovalMetadata(flags));
    } catch (error) {
      if (permissionChanged && face !== undefined && previous !== undefined) {
        await face.setModeAndBroadcast(previous).catch((rollbackError: unknown) => {
          this.log("Failed to restore session permission after a metadata error", rollbackError);
        });
      }
      throw error;
    }
    this.legacyApproval = flags;
  }

  async updateMetadataFlags(patch: Record<string, unknown>): Promise<void> {
    await this.updateMetadata(patch);
  }

  async applyPermissionMode(mode: PermissionMode): Promise<void> {
    this.ensureOpen();
    const face = this.resolveOptional<PermissionFace>(PermissionRef, "agent");
    if (face !== undefined && face.state.value.mode !== mode) {
      await face.setModeAndBroadcast(mode);
    }
  }

  private async updateMetadata(patch: Record<string, unknown>): Promise<void> {
    const metadata = await this.updateMetadataDelegate(this.id, patch);
    if (metadata !== undefined) {
      this.record = {
        id: this.id,
        title: this.record?.title,
        metadata: metadata as Record<string, unknown>,
      };
    }
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

    if (event.type === "turn.started" && event.agentId === MAIN_AGENT_ID && this.activePrompt !== undefined) {
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
    if (event.agentId !== MAIN_AGENT_ID) return;
    if (event.name !== "Write" && event.name !== "Edit") return;
    if (!isRecord(event.args)) return;
    const filePath = event.args["path"] ?? event.args["file_path"];
    if (typeof filePath !== "string" || filePath.length === 0) return;

    this.captureBaseline(this.summary, filePath, this.subscribers);
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
      this.requestSessionTitle();
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

  private requestSessionTitle(): void {
    if (this.titleRequested) return;
    this.titleRequested = true;
    const title = this.resolveOptional<SessionTitleFace>(SessionTitleRef, "session");
    void title?.generateTitle({ source: "first_turn" }).catch(() => undefined);
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
      _sessionId: this.id,
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

export function toEngineUserMessage(input: string | LegacyContentPart[]): UserMessage {
  const parts: EngineContentPart[] = [];
  const legacyParts: readonly LegacyContentPart[] =
    typeof input === "string" ? [{ type: "text", text: input }] : input;
  for (const part of legacyParts) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image_url":
        parts.push({ type: "image_url", source: mediaSourceFromUrl(part.image_url.url) });
        break;
      case "video_url":
        parts.push({ type: "video_url", source: mediaSourceFromUrl(part.video_url.url) });
        break;
      case "audio_url":
        parts.push({ type: "audio_url", source: mediaSourceFromUrl(part.audio_url.url) });
        break;
      case "think":
        break;
    }
  }
  return { role: "user", content: parts };
}

function mediaSourceFromUrl(url: string): MediaSource {
  if (url.startsWith("media://")) return { kind: "store", ref: url };
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (data !== null) {
    return {
      kind: "inline",
      mimeType: data[1] ?? "application/octet-stream",
      data: data[3] ?? "",
    };
  }
  return { kind: "url", url };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
