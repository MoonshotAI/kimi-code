import type { AgentActivityUpdated } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type { ContextSpliced } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { HookResult } from '@moonshot-ai/agent-core-v2/features/externalHooks/agent/agentExternalHooksService';
import type {
  CompactionBlocked,
  CompactionCancelled,
  CompactionCompleted,
  CompactionStarted,
} from '@moonshot-ai/agent-core-v2/agent/fullCompaction/compactionOps';
import type { GoalUpdated } from '@moonshot-ai/agent-core-v2';
import type {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepStarted,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type { AgentErrorEvent } from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';
import type { PluginCommandActivated } from '@moonshot-ai/agent-core-v2/agent/pluginCommand/pluginCommand';
import type { WarningIssued } from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import type {
  PromptAborted,
  PromptCompleted,
  PromptSteered,
} from '@moonshot-ai/agent-core-v2/agent/prompt/promptService';
import type {
  ShellCompleted,
  ShellOutput,
  ShellStarted,
} from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommandService';
import type { SkillActivated } from '@moonshot-ai/agent-core-v2/agent/skill/skillOps';
import type { TurnStepRetrying } from '@moonshot-ai/agent-core-v2/agent/stepRetry/stepRetryService';
import type {
  TaskNotified,
  TaskStarted,
  TaskTerminatedNotice,
} from '@moonshot-ai/agent-core-v2/agent/task/taskOps';
import type {
  ToolCallStarted,
  ToolProgress,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { AgentStatusUpdated } from '@moonshot-ai/agent-core-v2/agent/usage/usageEvents';
import type { PlanRevision } from '@moonshot-ai/agent-core-v2/features/plan/planOps';
import type { SubagentSuspended } from '@moonshot-ai/agent-core-v2/features/swarm/session/sessionSwarmService';
import type { CronFired } from '@moonshot-ai/agent-core-v2/session/cron/cronOps';
import type {
  SubagentCompleted,
  SubagentFailed,
  SubagentSpawned,
  SubagentStarted,
} from '@moonshot-ai/agent-core-v2/session/subagent/mirrorAgentRun';
import type {
  AgentRef,
  AgentUsageMeta,
  StepHeader,
  StepUsage,
  TextFrame,
  ToolCallFrame,
  ToolFrameProgress,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptMarker,
  TranscriptOperation,
  TranscriptPrompt,
  TranscriptTask,
  TranscriptTodo,
  TranscriptUsage,
  TurnHeader,
  TurnOrigin,
  TurnState,
} from '@moonshot-ai/transcript';

import { toLegacyPhase } from '../legacyStatus/legacyStatus';
import { projectPromptContentParts } from '../messages/messageProjection';

export interface ProjectorInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  /** In-process `ApprovalRequest` / `QuestionRequest`, passed through as-is. */
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string; readonly turnId?: number };
}

type PlanRevisionEvent = { readonly type: 'plan.revision' } & PlanRevision;

type AgentActivityUpdatedEvent = { readonly type: 'agent.activity.updated' } & AgentActivityUpdated;
type PromptCompletedEvent = { readonly type: 'prompt.completed' } & PromptCompleted;
type PromptAbortedEvent = { readonly type: 'prompt.aborted' } & PromptAborted;
type PromptSteeredEvent = { readonly type: 'prompt.steered' } & PromptSteered;

export type ProjectorBusEvent =
  | PlanRevisionEvent
  | ({ readonly type: 'turn.started' } & TurnStarted)
  | ({ readonly type: 'turn.ended' } & TurnEnded)
  | ({ readonly type: 'turn.step.started' } & TurnStepStarted)
  | ({ readonly type: 'turn.step.completed' } & TurnStepCompleted)
  | ({ readonly type: 'turn.step.interrupted' } & TurnStepInterrupted)
  | ({ readonly type: 'turn.step.retrying' } & TurnStepRetrying)
  | ({ readonly type: 'assistant.delta' } & AssistantDelta)
  | ({ readonly type: 'thinking.delta' } & ThinkingDelta)
  | ({ readonly type: 'tool.call.delta' } & ToolCallDelta)
  | ({ readonly type: 'tool.progress' } & ToolProgress)
  | ({ readonly type: 'tool.call.started' } & ToolCallStarted)
  | ({ readonly type: 'tool.result' } & ToolResultEvent)
  | ({ readonly type: 'task.started' } & TaskStarted)
  | ({ readonly type: 'task.terminated' } & TaskTerminatedNotice)
  | ({ readonly type: 'task.notified' } & TaskNotified)
  | ({ readonly type: 'shell.started' } & ShellStarted)
  | ({ readonly type: 'shell.output' } & ShellOutput)
  | ({ readonly type: 'shell.completed' } & ShellCompleted)
  | ({ readonly type: 'subagent.spawned' } & SubagentSpawned)
  | ({ readonly type: 'subagent.started' } & SubagentStarted)
  | ({ readonly type: 'subagent.completed' } & SubagentCompleted)
  | ({ readonly type: 'subagent.failed' } & SubagentFailed)
  | ({ readonly type: 'subagent.suspended' } & SubagentSuspended)
  | ({ readonly type: 'goal.updated' } & GoalUpdated)
  | ({ readonly type: 'agent.status.updated' } & AgentStatusUpdated)
  | AgentActivityUpdatedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent
  | ({ readonly type: 'hook.result' } & HookResult)
  | ({ readonly type: 'skill.activated' } & SkillActivated)
  | ({ readonly type: 'plugin_command.activated' } & PluginCommandActivated)
  | ({ readonly type: 'cron.fired' } & CronFired)
  | ({ readonly type: 'compaction.started' } & CompactionStarted)
  | ({ readonly type: 'compaction.blocked' } & CompactionBlocked)
  | ({ readonly type: 'compaction.cancelled' } & CompactionCancelled)
  | ({ readonly type: 'compaction.completed' } & CompactionCompleted)
  | ({ readonly type: 'context.spliced' } & ContextSpliced)
  | ({ readonly type: 'error' } & AgentErrorEvent)
  | ({ readonly type: 'warning' } & WarningIssued);

/**
 * The v1-wire `prompt.submitted` shape (kap-server `protocol/events-zod.ts`).
 * The v2 bus never publishes it (see `agent/prompt/promptService.ts`, which
 * emits only completed / aborted / steered), so it is declared here rather
 * than derived from `DomainEvent`; `map` accepts it so an edge that learns
 * about a submission (REST prompt path, a future engine event) can project it
 * through the same entry point.
 */
export interface ProjectorPromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content?: unknown;
  readonly createdAt: string;
}

/**
 * Read access to one step's current frames (the producer store). Used for
 * mid-stream attach adoption — see `adoptStreamFrame`.
 */
export type ProjectorFrameLookup = (
  turnId: string,
  stepId: string,
) => readonly TranscriptFrame[] | undefined;

/**
 * Locate a tool frame by its toolCallId across the producer store. Used for
 * mid-bind result adoption — see `adoptToolFrame`.
 */
export type ProjectorToolFrameLookup = (toolCallId: string) => ToolFrameRecord | undefined;

/**
 * The engine-reported current step ordinal for a turn (the activity view).
 * Used to place deltas correctly when the projector attached after
 * `turn.step.started` for a later step — see `ensureStep`.
 */
export type ProjectorStepOrdinalLookup = (turnId: string) => number | undefined;

export type ProjectorTurnLookup = (turnId: string) => TurnHeader | undefined;

/** Optional producer-store lookups that let the projector adopt seeded state. */
export interface ProjectorLookups {
  readonly stepFrames?: ProjectorFrameLookup;
  readonly toolFrame?: ProjectorToolFrameLookup;
  readonly stepOrdinal?: ProjectorStepOrdinalLookup;
  readonly turn?: ProjectorTurnLookup;
}

interface OpenTextFrame {
  readonly frameId: string;
  offset: number;
  text: string;
}

export interface ToolFrameRecord {
  readonly turnId: string;
  readonly stepId: string;
  readonly frame: ToolCallFrame;
}

export class AgentTranscriptProjector {
  /** Latest header of the in-flight (or most recent) turn; kept whole so terminal upserts preserve `origin` / `startedAt` by reference. */
  private currentTurn: TurnHeader | undefined;
  private currentStep: StepHeader | undefined;
  /** turnId → highest step ordinal seen (engine-reported placement hint). */
  private readonly stepOrdinals = new Map<string, number>();
  private frameOrdinal = 0;
  private openText: OpenTextFrame | undefined;
  private openThinking: OpenTextFrame | undefined;
  private readonly toolFrames = new Map<string, ToolFrameRecord>();
  /** Last whole TranscriptTask emitted per task id (`task.upsert` replaces, so the local copy must carry `outputTail` forward). */
  private readonly tasks = new Map<string, TranscriptTask>();
  /** shell `commandId` → transcript `taskId` (`shell.output` is keyed by command id only). */
  private readonly shellTasks = new Map<string, string>();
  /** subagent agent id → registered task id, for Agent-tool runs whose spawned
      carried the registration (`taskId`): the task row keys by the task id so
      `/tasks/{id}` actions resolve, and lifecycle events fold back to it. */
  private readonly subagentTaskIds = new Map<string, string>();

  /** Pre-seed the association and the row for a task registered before
      attach: a foreground Agent run emits no `task.started` at all, so
      without this a late-bound projector never learns the mapping, shows no
      cancellable row, and lets the terminal event invent foreground-wrong
      defaults. Only in-flight tasks seed (a terminal one has no lifecycle
      left to fold). */
  seedSubagentTask(info: {
    readonly taskId: string;
    readonly agentId: string;
    readonly description: string;
    readonly status: string;
    readonly detached: boolean;
    readonly startedAt: number;
  }): TranscriptOperation[] {
    if (info.status !== 'running') return [];
    this.subagentTaskIds.set(info.agentId, info.taskId);
    const task = this.upsertTask(info.taskId, (prev) => ({
      taskId: info.taskId,
      kind: 'subagent',
      state: 'running',
      detached: info.detached,
      description: info.description,
      agentId: info.agentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: prev?.endedAt,
    }));
    return [{ op: 'task.upsert', task }];
  }
  /** interaction id → the pending entity as last emitted (resolve spreads it). */
  private readonly interactions = new Map<string, TranscriptInteraction>();
  /** promptId → the prompt queue entity as last emitted (`prompt.upsert` replaces). */
  private readonly prompts = new Map<string, TranscriptPrompt>();
  /** turnId → step usages reported so far; folded into the turn header at `turn.ended`. */
  private readonly stepUsageByTurn = new Map<string, StepUsage[]>();
  private markerSeq = 0;
  /** Tracked from `agent.status.updated` planMode slices; gates the badge refinement on `plan.revision`. */
  private planModeActive = false;

  constructor(
    readonly agentId: string,
    private readonly lookups?: ProjectorLookups,
  ) {}

  map(event: ProjectorBusEvent | ProjectorPromptSubmittedEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'plan.revision':
        return this.onPlanRevision(event);
      case 'turn.started':
        return this.onTurnStarted(event);
      case 'turn.ended':
        return this.onTurnEnded(event);
      case 'turn.step.started':
        return this.onStepStarted(event);
      case 'turn.step.completed':
        return this.onStepCompleted(event);
      case 'turn.step.interrupted':
        return this.onStepFinished(event);
      case 'turn.step.retrying':
        return this.onStepRetrying(event);
      case 'assistant.delta':
        return this.onTextDelta(event.turnId, 'assistant', event.delta);
      case 'thinking.delta':
        return this.onTextDelta(event.turnId, 'thinking', event.delta);
      case 'tool.call.delta':
        return this.onToolCallDelta(event);
      case 'tool.progress':
        return this.onToolProgress(event);
      case 'tool.call.started':
        return this.onToolCallStarted(event);
      case 'tool.result':
        return this.onToolResult(event);
      case 'task.started':
      case 'task.terminated':
        return this.onTaskLifecycle(event);
      case 'task.notified':
        return this.onTaskNotified(event);
      case 'shell.started':
        return this.onShellStarted(event);
      case 'shell.output':
        return this.onShellOutput(event);
      case 'shell.completed':
        return this.onShellCompleted(event);
      case 'subagent.spawned':
        return this.onSubagentSpawned(event);
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.suspended':
        return this.onSubagentRun(event);
      case 'goal.updated':
        return this.onGoalUpdated(event);
      case 'agent.status.updated':
        return this.onAgentStatusUpdated(event);
      case 'agent.activity.updated':
        return this.onAgentActivityUpdated(event);
      case 'prompt.submitted':
        return this.onPromptSubmitted(event);
      case 'prompt.completed':
        return this.onPromptCompleted(event);
      case 'prompt.aborted':
        return this.onPromptAborted(event);
      case 'prompt.steered':
        return this.onPromptSteered(event);
      case 'hook.result':
        return [this.markerOp('hook', restOf(event))];
      case 'skill.activated':
        return [this.markerOp('skill', restOf(event))];
      case 'plugin_command.activated':
        return [this.markerOp('skill', { ...restOf(event), variant: 'plugin_command' })];
      case 'cron.fired':
        return [this.markerOp('cron.fired', restOf(event))];
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
        return [
          this.markerOp('compaction', {
            phase: event.type.slice('compaction.'.length),
            ...restOf(event),
          }),
        ];
      case 'context.spliced':
        return [this.markerOp('undo', restOf(event))];
      case 'error':
        return [this.noticeOp('error', event.message, restOf(event))];
      case 'warning':
        return [this.noticeOp('warning', event.message, restOf(event))];
      default:
        return [];
    }
  }

  private onTurnStarted(event: {
    turnId: number;
    origin: unknown;
    prompt?: string;
    promptAttachments?: readonly { kind: 'image' | 'video' | 'audio'; fileId: string }[];
  }): TranscriptOperation[] {
    const n = event.turnId;
    const turnId = `t${n}`;
    const ops: TranscriptOperation[] = [];
    const attachmentIds: string[] = [];
    for (const input of event.promptAttachments ?? []) {
      const attachment: TranscriptAttachment = {
        attachmentId: `${turnId}.att${attachmentIds.length + 1}`,
        mediaType: `${input.kind}/*`,
        source: { kind: 'session_media', fileId: input.fileId },
      };
      ops.push({ op: 'attachment.upsert', attachment });
      attachmentIds.push(attachment.attachmentId);
    }
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: n,
      state: 'running',
      origin: mapTurnOrigin(event.origin),
      prompt: event.prompt,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      startedAt: nowIso(),
    };
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    return ops;
  }

  private onTurnEnded(event: {
    time?: number;
    turnId: number;
    reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    error?: { message: string };
    durationMs?: number;
    interruptReason?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    if (this.currentStep !== undefined && this.currentStep.state === 'running') {
      const step: StepHeader = { ...this.currentStep, state: 'interrupted', endedAt: nowIso() };
      this.currentStep = step;
      ops.push({ op: 'step.upsert', turnId: step.turnId, step });
    }
    const prev =
      this.currentTurn?.turnId === turnId ? this.currentTurn : this.lookups?.turn?.(turnId);
    const state = mapTurnEndState(event.reason);
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: event.turnId,
      state,
      origin: prev?.origin ?? { kind: 'other' },
      prompt: prev?.prompt,
      attachmentIds: prev?.attachmentIds,
      startedAt: prev?.startedAt,
      endedAt: event.time === undefined ? nowIso() : epochMsToIso(event.time),
      durationMs: event.durationMs,
      error: event.error?.message,
      usage: this.takeTurnUsage(turnId),
    };
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    this.currentStep = undefined;
    if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
      ops.push(
        this.markerOp('interruption', { turnId: event.turnId, reason: event.interruptReason }),
      );
    }
    return ops;
  }

  /**
   * Fold this turn's accumulated step usages into the turn header's
   * `TranscriptUsage` and drop the accumulator. Step usages are the engine's
   * four-component `TokenUsage`; the header maps them to the render vocabulary
   * (`inputTokens = inputOther + inputCacheCreation`,
   * `cachedTokens = inputCacheRead`, `outputTokens = output`). A turn whose
   * steps all reported no usage gets no `usage` at all (the components have
   * no data either way — the wire never omits a single component).
   */
  private takeTurnUsage(turnId: string): TranscriptUsage | undefined {
    const usages = this.stepUsageByTurn.get(turnId);
    this.stepUsageByTurn.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    let inputOther = 0;
    let output = 0;
    let inputCacheRead = 0;
    let inputCacheCreation = 0;
    for (const usage of usages) {
      inputOther += usage.inputOther;
      output += usage.output;
      inputCacheRead += usage.inputCacheRead;
      inputCacheCreation += usage.inputCacheCreation;
    }
    return {
      inputTokens: inputOther + inputCacheCreation,
      cachedTokens: inputCacheRead,
      outputTokens: output,
    };
  }

  private onStepStarted(event: { turnId: number; step: number }): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    this.stepOrdinals.set(turnId, event.step);
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: nowIso(),
    };
    this.frameOrdinal = 0;
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private onStepCompleted(event: {
    turnId: number;
    step: number;
    usage?: StepUsage;
    finishReason?: string;
    rawFinishReason?: string;
    providerFinishReason?: string;
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
    llmRequestBuildMs?: number;
    llmServerFirstTokenMs?: number;
    llmServerDecodeMs?: number;
    llmClientConsumeMs?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    if (event.usage !== undefined) {
      const usages = this.stepUsageByTurn.get(turnId) ?? [];
      usages.push(event.usage);
      this.stepUsageByTurn.set(turnId, usages);
    }
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'completed',
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      usage: event.usage,
      finishReason: event.finishReason ?? event.rawFinishReason ?? event.providerFinishReason,
      timing: {
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
      },
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private onStepFinished(event: {
    type: 'turn.step.interrupted';
    turnId: number;
    step: number;
    reason: string;
    message?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'interrupted',
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      endReason: event.reason,
      endMessage: event.message,
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  /**
   * `turn.step.retrying` — a claimed provider failure is being retried on the
   * same step. The step stays 'running' with the retry detail on the header;
   * the terminal step upsert simply carries no `retry`, which clears it
   * (step.upsert replaces the whole header).
   */
  private onStepRetrying(event: {
    turnId: number;
    step: number;
    failedAttempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    errorName: string;
    errorMessage: string;
    statusCode?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: prev?.startedAt,
      retry: {
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      },
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private onTextDelta(
    turnNumber: number,
    kind: 'assistant' | 'thinking',
    delta: string,
  ): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${turnNumber}`;
    const step = this.ensureStep(turnId, ops);
    let open = kind === 'assistant' ? this.openText : this.openThinking;
    open ??= this.adoptStreamFrame(turnId, step.stepId, kind);
    if (open === undefined) {
      const frameId = `${step.stepId}.f${++this.frameOrdinal}`;
      open = { frameId, offset: 0, text: '' };
      ops.push({
        op: 'frame.upsert',
        turnId,
        stepId: step.stepId,
        frame:
          kind === 'assistant'
            ? { kind: 'text', frameId, role: 'assistant', text: '' }
            : { kind: 'thinking', frameId, text: '' },
      });
    }
    ops.push({
      op: 'append',
      target: { type: 'frame', turnId, stepId: step.stepId, frameId: open.frameId },
      offset: open.offset,
      text: delta,
    });
    open.offset += delta.length;
    open.text += delta;
    if (kind === 'assistant') this.openText = open;
    else this.openThinking = open;
    return ops;
  }

  /**
   * Mid-stream attach adoption. When the projector starts streaming a step it
   * has never seen, the history backfill may already have seeded that step's
   * stream frame with the text persisted so far (the in-flight turn's deltas
   * are persisted upstream). Opening a fresh frame here would emit an empty
   * `frame.upsert` that clobbers the seeded text, followed by offset-0
   * appends that cannot land past it — corrupting the live transcript until
   * the next cold rebuild. Instead adopt the seeded frame: continue its id
   * and offset (the persisted text is a prefix of the same stream), and
   * advance `frameOrdinal` past the step's existing `.fN` frames so later
   * frames cannot collide. Known limitation: deltas observed between bind
   * and the backfill landing still open a fresh frame (the backfill's later
   * upsert then replaces it wholesale).
   */
  private adoptStreamFrame(
    turnId: string,
    stepId: string,
    kind: 'assistant' | 'thinking',
  ): OpenTextFrame | undefined {
    const frames = this.lookups?.stepFrames?.(turnId, stepId);
    if (frames === undefined || frames.length === 0) return undefined;
    for (const frame of frames) {
      const match = /\.f(\d+)$/.exec(frame.frameId);
      if (match !== null) {
        this.frameOrdinal = Math.max(this.frameOrdinal, Number(match[1]));
      }
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (frame === undefined) continue;
      if (kind === 'assistant' && frame.kind === 'text' && frame.role === 'assistant') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
      if (kind === 'thinking' && frame.kind === 'thinking') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
    }
    return undefined;
  }

  /** Re-emit every open text/thinking frame with its full text (the 'block'-grade convergence point). */
  private flushOpenFrames(ops: TranscriptOperation[]): void {
    const step = this.currentStep;
    for (const open of [this.openText, this.openThinking]) {
      if (open === undefined || step === undefined) continue;
      const isText = open === this.openText;
      ops.push({
        op: 'frame.upsert',
        turnId: step.turnId,
        stepId: step.stepId,
        frame: isText
          ? { kind: 'text', frameId: open.frameId, role: 'assistant', text: open.text }
          : { kind: 'thinking', frameId: open.frameId, text: open.text },
      });
    }
    this.openText = undefined;
    this.openThinking = undefined;
  }

  /**
   * Resolve the step a content event belongs to. When the projector missed
   * `turn.step.started` (mid-stream attach), prefer the engine-reported
   * active step from the activity view; then the latest step this projector
   * saw; only then the `t<N>.1` fallback (the store skeleton-fills anything
   * still missing). Without the lookup a late attach at step ≥ 2 would
   * stream into the wrong step.
   */
  private ensureStep(turnId: string, ops: TranscriptOperation[]): StepHeader {
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      return this.currentStep;
    }
    const ordinal =
      this.lookups?.stepOrdinal?.(turnId) ?? this.stepOrdinals.get(turnId) ?? 1;
    this.currentStep = {
      kind: 'step',
      stepId: `${turnId}.${ordinal}`,
      turnId,
      ordinal,
      state: 'running',
      startedAt: nowIso(),
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return this.currentStep;
  }

  /**
   * `tool.call.delta` — raw argument streaming. The deltas accumulate into the
   * frame's `inputText` (the verbatim counterpart of the parsed `input`). A
   * delta can arrive before `tool.call.started` (the stream reports arguments
   * as they generate): the frame is then created here, and the later started
   * event fills in name/input/display while keeping the accumulated text.
   */
  private onToolCallDelta(event: {
    turnId: number;
    toolCallId: string;
    name?: string;
    argumentsPart?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const prev = this.toolFrames.get(event.toolCallId);
    if (prev !== undefined) {
      const frame: ToolCallFrame = {
        ...prev.frame,
        inputText: (prev.frame.inputText ?? '') + (event.argumentsPart ?? ''),
      };
      this.toolFrames.set(event.toolCallId, { ...prev, frame });
      ops.push({ op: 'frame.upsert', turnId: prev.turnId, stepId: prev.stepId, frame });
      return ops;
    }
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId,
      toolCallId: event.toolCallId,
      name: event.name ?? '',
      state: 'running',
      inputText: event.argumentsPart ?? '',
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  /**
   * `tool.progress` — the newest execution update overwrites the frame's
   * `progress` (whole-frame upsert, as for every tool frame mutation).
   */
  private onToolProgress(event: {
    toolCallId: string;
    update: ToolFrameProgress;
  }): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId) ?? this.adoptToolFrame(event.toolCallId);
    if (hit === undefined) return [];
    const frame: ToolCallFrame = {
      ...hit.frame,
      progress: {
        kind: event.update.kind,
        text: event.update.text,
        percent: event.update.percent,
        customKind: event.update.customKind,
        customData: event.update.customData,
      },
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private onToolCallStarted(event: {
    turnId: number;
    toolCallId: string;
    name: string;
    args: unknown;
    display?: unknown;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const input = parseToolArgs(event.args);
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId,
      toolCallId: event.toolCallId,
      name: event.name,
      state: 'running',
      input,
      inputText: this.toolFrames.get(event.toolCallId)?.frame.inputText,
      display: event.display,
      todoId: event.name === TODO_LIST_TOOL_NAME && todoWriteItems(input) !== undefined ? TODO_ENTITY_ID : undefined,
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private onToolResult(event: {
    toolCallId: string;
    output: unknown;
    isError?: boolean;
  }): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId) ?? this.adoptToolFrame(event.toolCallId);
    if (hit === undefined) return [];
    const isError = event.isError === true;
    const frame: ToolCallFrame = {
      ...hit.frame,
      state: isError ? 'error' : 'done',
      output: event.output,
      error: isError && typeof event.output === 'string' ? event.output : undefined,
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    const ops: TranscriptOperation[] = [
      { op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame },
    ];
    if (!isError && frame.name === TODO_LIST_TOOL_NAME) {
      const items = todoWriteItems(frame.input);
      if (items !== undefined) {
        const todo: TranscriptTodo = { todoId: TODO_ENTITY_ID, items, updatedAt: nowIso() };
        ops.push({ op: 'todo.upsert', todo });
      }
    }
    return ops;
  }

  /**
   * Mid-bind adoption: the transcript may have attached after `tool.call.started`
   * (the backfill seeded the frame from the persisted assistant toolCalls) but
   * before `tool.result`. This projector's map is empty then and the result
   * would be dropped; adopt the seeded frame so the result lands where a live
   * observer put it.
   */
  private adoptToolFrame(toolCallId: string): ToolFrameRecord | undefined {
    const hit = this.lookups?.toolFrame?.(toolCallId);
    if (hit === undefined) return undefined;
    this.toolFrames.set(toolCallId, hit);
    return hit;
  }

  /**
   * `task.notified` — a background task's completion notification. Mid-turn
   * the engine injects the notification message into the running turn's
   * context, so it surfaces as a user input frame inside the open step,
   * linked to the task entity (`text.taskId`). When no step is open the
   * notification opens a fresh turn with `origin.kind === 'task'` instead
   * (the `turn.started` path owns that case).
   */
  private onTaskNotified(event: {
    notificationType: string;
    title: string;
    body: string;
    severity: string;
    sourceKind: string;
    sourceId: string;
  }): TranscriptOperation[] {
    const step = this.currentStep;
    const turn = this.currentTurn;
    const midTurn =
      step !== undefined &&
      turn !== undefined &&
      step.state === 'running' &&
      turn.state === 'running';
    if (!midTurn) return [];
    const frame: TextFrame = {
      kind: 'text',
      frameId: `${step.stepId}.f${++this.frameOrdinal}`,
      role: 'user',
      text: `${event.title}\n${event.body}`.trim(),
      taskId: event.sourceId,
    };
    return [{ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame }];
  }

  private onTaskLifecycle(event: {
    type: 'task.started' | 'task.terminated';
    info: {
      taskId: string;
      kind: string;
      description: string;
      status: TranscriptTask['state'];
      detached?: boolean;
      agentId?: string;
      startedAt: number;
      endedAt: number | null;
    };
  }): TranscriptOperation[] {
    const { info } = event;
    const task = this.upsertTask(info.taskId, (prev) => ({
      taskId: info.taskId,
      kind: mapTaskKind(info.kind),
      state: info.status,
      detached: info.detached ?? prev?.detached ?? true,
      description: info.description,
      agentId: info.agentId ?? prev?.agentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: info.endedAt === null ? prev?.endedAt : epochMsToIso(info.endedAt),
      resultSummary: prev?.resultSummary,
      usage: prev?.usage,
      error: prev?.error,
      stateReason: prev?.stateReason,
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (event.type === 'task.started') {
      if (info.kind === 'agent' && typeof info.agentId === 'string' && info.agentId.length > 0) {
        this.subagentTaskIds.set(info.agentId, info.taskId);
      }
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${info.taskId}`, taskId: info.taskId, at: nowIso() },
      });
    }
    return ops;
  }

  private onShellStarted(event: { commandId: string; taskId: string }): TranscriptOperation[] {
    this.shellTasks.set(event.commandId, event.taskId);
    const task = this.upsertTask(event.taskId, (prev) => ({
      taskId: event.taskId,
      kind: 'shell',
      state: 'running',
      detached: prev?.detached ?? false,
      description: prev?.description,
      agentId: prev?.agentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: prev?.endedAt,
    }));
    return [
      { op: 'task.upsert', task },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${event.taskId}`, taskId: event.taskId, at: nowIso() },
      },
    ];
  }

  /**
   * Resolve the transcript task for a `shell.*` event: the id learned at
   * `shell.started`, else the id the event carries (mid-command attach), else
   * a synthetic per-command id. The fallback matters for commands that fail
   * before `onForegroundTaskStart` runs (Bash validation/spawn errors): their
   * events all arrive taskId-less, and dropping them would lose the stderr
   * and the terminal state of a command that did run.
   */
  private shellTaskId(event: { commandId: string; taskId?: string }): string {
    const taskId = this.shellTasks.get(event.commandId) ?? event.taskId ?? `shell-${event.commandId}`;
    this.shellTasks.set(event.commandId, taskId);
    return taskId;
  }

  private onShellOutput(event: {
    commandId: string;
    taskId?: string;
    update: { kind: string; text?: string };
  }): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const text = event.update.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const ops: TranscriptOperation[] = [];
    let task = this.tasks.get(taskId);
    if (task === undefined) {
      task = this.upsertTask(taskId, (prev) => ({
        taskId,
        kind: 'shell',
        state: 'running',
        detached: prev?.detached ?? false,
        description: prev?.description,
        agentId: prev?.agentId,
        outputTail: prev?.outputTail ?? '',
        startedAt: prev?.startedAt ?? nowIso(),
        endedAt: prev?.endedAt,
      }));
      ops.push(
        { op: 'task.upsert', task },
        {
          op: 'taskref.upsert',
          item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: nowIso() },
        },
      );
    }
    const offset = task.outputTail.length;
    this.tasks.set(taskId, { ...task, outputTail: task.outputTail + text });
    ops.push({ op: 'append', target: { type: 'task', taskId }, offset, text });
    return ops;
  }

  /**
   * `shell.completed` — terminal state for a foreground `!` command (the task
   * lifecycle never reports foreground tasks, so without this the transcript
   * task would stay 'running' forever). Detached runs report through
   * `task.*` instead.
   */
  private onShellCompleted(event: {
    commandId: string;
    taskId?: string;
    isError: boolean;
  }): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const hadTask = this.tasks.has(taskId);
    const task = this.upsertTask(taskId, (prev) => ({
      taskId,
      kind: prev?.kind ?? 'shell',
      state: event.isError ? 'failed' : 'completed',
      detached: prev?.detached ?? false,
      description: prev?.description,
      agentId: prev?.agentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: nowIso(),
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (!hadTask) {
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: nowIso() },
      });
    }
    return ops;
  }

  private upsertTask(
    taskId: string,
    build: (prev: TranscriptTask | undefined) => TranscriptTask,
  ): TranscriptTask {
    const task = build(this.tasks.get(taskId));
    this.tasks.set(taskId, task);
    return task;
  }

  private onSubagentSpawned(event: {
    subagentId: string;
    subagentName: string;
    parentToolCallId: string;
    description?: string;
    swarmIndex?: number;
    runInBackground: boolean;
    taskId?: string;
  }): TranscriptOperation[] {
    const taskKey = event.taskId ?? event.subagentId;
    if (event.taskId !== undefined) {
      this.subagentTaskIds.set(event.subagentId, event.taskId);
    } else {
      this.subagentTaskIds.delete(event.subagentId);
    }
    const task = this.upsertTask(taskKey, (prev) => ({
      taskId: taskKey,
      kind: 'subagent',
      state: 'running',
      detached: event.runInBackground,
      description: event.description ?? prev?.description,
      agentId: event.subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: prev?.endedAt,
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    const hit =
      this.toolFrames.get(event.parentToolCallId) ?? this.adoptToolFrame(event.parentToolCallId);
    if (hit !== undefined) {
      const ref: AgentRef = {
        agentId: event.subagentId,
        role: event.swarmIndex !== undefined ? 'member' : 'child',
      };
      const frame: ToolCallFrame = {
        ...hit.frame,
        agentRefs: [...(hit.frame.agentRefs ?? []), ref],
      };
      this.toolFrames.set(event.parentToolCallId, { ...hit, frame });
      ops.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame });
    }
    return ops;
  }

  private onSubagentRun(event: {
    type: 'subagent.started' | 'subagent.completed' | 'subagent.failed' | 'subagent.suspended';
    subagentId: string;
    resultSummary?: string;
    usage?: StepUsage;
    error?: string;
    reason?: string;
  }): TranscriptOperation[] {
    const state: TranscriptTask['state'] =
      event.type === 'subagent.completed'
        ? 'completed'
        : event.type === 'subagent.failed'
          ? 'failed'
          : 'running';
    const taskKey = this.subagentTaskIds.get(event.subagentId) ?? event.subagentId;
    const task = this.upsertTask(taskKey, (prev) => ({
      taskId: taskKey,
      kind: 'subagent',
      state,
      detached: prev?.detached ?? true,
      description: prev?.description,
      agentId: event.subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt:
        event.type === 'subagent.completed' || event.type === 'subagent.failed'
          ? nowIso()
          : prev?.endedAt,
      resultSummary: event.resultSummary ?? prev?.resultSummary,
      usage: event.usage ?? prev?.usage,
      error: event.error ?? prev?.error,
      stateReason: event.reason ?? prev?.stateReason,
    }));
    return [{ op: 'task.upsert', task }];
  }

  private onGoalUpdated(event: {
    readonly type: string;
    snapshot: {
      objective: string;
      status: 'active' | 'paused' | 'blocked' | 'complete';
      completionCriterion?: string;
      tokensUsed: number;
      budget: { tokenBudget: number | null };
    } | null;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const snapshot = event.snapshot;
    if (snapshot === null) {
      ops.push({ op: 'meta.merge', meta: { goal: null } });
    } else {
      ops.push({
        op: 'meta.merge',
        meta: {
          goal: {
            objective: snapshot.objective,
            status: snapshot.status,
            completionCriterion: snapshot.completionCriterion,
            budgetUsed: snapshot.tokensUsed,
            budgetLimit: snapshot.budget.tokenBudget ?? undefined,
          },
        },
      });
    }
    ops.push(this.markerOp('goal', restOf(event)));
    return ops;
  }

  private onAgentStatusUpdated(event: {
    planMode?: boolean;
    swarmMode?: boolean;
    model?: string;
    thinkingEffort?: string;
    usage?: AgentUsageMeta;
    contextTokens?: number;
    maxContextTokens?: number;
    contextUsage?: number;
    permission?: 'manual' | 'yolo' | 'auto';
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const modes: { plan?: Record<string, never> | null; swarm?: Record<string, never> | null } = {};
    if (event.planMode === true) {
      modes.plan = {};
      this.planModeActive = true;
    } else if (event.planMode === false) {
      modes.plan = null;
      this.planModeActive = false;
    }
    if (event.swarmMode === true) modes.swarm = {};
    else if (event.swarmMode === false) modes.swarm = null;
    if (modes.plan !== undefined || modes.swarm !== undefined) {
      ops.push({ op: 'meta.merge', meta: { modes } });
    }
    const agent: {
      model?: string;
      thinkingEffort?: string;
      usage?: AgentUsageMeta;
      contextTokens?: number;
      maxContextTokens?: number;
      contextUsage?: number;
      permission?: 'manual' | 'yolo' | 'auto';
    } = {};
    let hasStatusSlice = false;
    if (event.model !== undefined) {
      agent.model = event.model;
      hasStatusSlice = true;
    }
    if (event.thinkingEffort !== undefined) {
      agent.thinkingEffort = event.thinkingEffort;
      hasStatusSlice = true;
    }
    if (event.usage !== undefined) {
      agent.usage = event.usage;
      hasStatusSlice = true;
    }
    if (event.contextTokens !== undefined) {
      agent.contextTokens = event.contextTokens;
      hasStatusSlice = true;
    }
    if (event.maxContextTokens !== undefined) {
      agent.maxContextTokens = event.maxContextTokens;
      hasStatusSlice = true;
    }
    if (event.contextUsage !== undefined) {
      agent.contextUsage = event.contextUsage;
      hasStatusSlice = true;
    }
    if (event.permission !== undefined) {
      agent.permission = event.permission;
      hasStatusSlice = true;
    }
    if (hasStatusSlice) {
      ops.push({ op: 'meta.merge', meta: { agent } });
    }
    return ops;
  }

  /**
   * `agent.activity.updated` — the engine's folded activity view. Projected
   * through `toLegacyPhase` (the same v1 phase projection the WS edge uses —
   * see `sessionEventBroadcaster.ts`) into `meta.agent.phase`; `disposing` /
   * `disposed` states map to `undefined` and emit nothing, as at the edge.
   */
  private onAgentActivityUpdated(event: AgentActivityUpdatedEvent): TranscriptOperation[] {
    const phase = toLegacyPhase(event);
    if (phase === undefined) return [];
    return [{ op: 'meta.merge', meta: { agent: { phase } } }];
  }

  /**
   * `plan.revision` — a plan content version was offloaded on review
   * submission. Always lands as a 'plan.revision' timeline marker (it stays
   * after plan mode exits); while plan mode is still active it also refines
   * the plan badge with the revision reference (`exit`/`cancel` later clear
   * the badge via the `planMode: false` slice, as before).
   */
  private onPlanRevision(event: PlanRevisionEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [this.markerOp('plan.revision', restOf(event))];
    if (this.planModeActive) {
      ops.push({
        op: 'meta.merge',
        meta: { modes: { plan: { reviewPath: event.path, version: event.version } } },
      });
    }
    return ops;
  }

  private markerOp(marker: string, payload: unknown): TranscriptOperation {
    this.markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      markerId: `live-m${this.markerSeq}`,
      marker,
      payload,
      at: nowIso(),
    };
    return { op: 'marker.upsert', item };
  }

  private noticeOp(
    level: 'error' | 'warning' | 'info',
    message: string,
    eventPayload: unknown,
  ): TranscriptOperation {
    return this.markerOp('notice', { level, message, event: eventPayload });
  }

  private onPromptSubmitted(event: ProjectorPromptSubmittedEvent): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, () => ({
      promptId: event.promptId,
      status: event.status,
      userMessageId: event.userMessageId,
      content: event.content,
      createdAt: event.createdAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onPromptCompleted(event: PromptCompletedEvent): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, (prev) => ({
      promptId: event.promptId,
      status: event.reason ?? 'completed',
      userMessageId: prev?.userMessageId,
      content: prev?.content,
      createdAt: prev?.createdAt ?? event.finishedAt,
      finishedAt: event.finishedAt,
      steeredAt: prev?.steeredAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onPromptAborted(event: PromptAbortedEvent): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, (prev) => ({
      promptId: event.promptId,
      status: 'aborted',
      userMessageId: prev?.userMessageId,
      content: prev?.content,
      createdAt: prev?.createdAt ?? event.abortedAt,
      finishedAt: event.abortedAt,
      steeredAt: prev?.steeredAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  /**
   * `prompt.steered` — queued prompts were merged into the running prompt's
   * turn (`AgentPromptService.steer`). The active prompt keeps running with
   * the merged content and the steer timestamp; the absorbed prompts leave
   * the queue — the engine marks them 'steered' and later settles them with
   * the active prompt's outcome, so the transcript settles them as
   * 'completed' (their content was delivered, not aborted).
   */
  private onPromptSteered(event: PromptSteeredEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const active = this.upsertPrompt(event.activePromptId, (prev) => ({
      promptId: event.activePromptId,
      status: prev?.status ?? 'running',
      userMessageId: prev?.userMessageId,
      content: projectPromptContentParts(event.content),
      createdAt: prev?.createdAt ?? event.steeredAt,
      finishedAt: prev?.finishedAt,
      steeredAt: event.steeredAt,
    }));
    ops.push({ op: 'prompt.upsert', prompt: active });
    for (const promptId of event.promptIds) {
      const steered = this.upsertPrompt(promptId, (prev) => ({
        promptId,
        status: 'completed',
        userMessageId: prev?.userMessageId,
        content: prev?.content,
        createdAt: prev?.createdAt ?? event.steeredAt,
        finishedAt: event.steeredAt,
        steeredAt: event.steeredAt,
      }));
      ops.push({ op: 'prompt.upsert', prompt: steered });
    }
    return ops;
  }

  private upsertPrompt(
    promptId: string,
    build: (prev: TranscriptPrompt | undefined) => TranscriptPrompt,
  ): TranscriptPrompt {
    const prompt = build(this.prompts.get(promptId));
    this.prompts.set(promptId, prompt);
    return prompt;
  }

  /**
   * `requested` — entity-only emission: the global interaction entity
   * (`interaction.upsert`), addressed by id, pagination-proof, visible at
   * 'turn' grade. Interactions never appear as inline step frames. The
   * entity's `toolCallId` (the timeline anchor) is read from the payload
   * when present and omitted otherwise; an unanchored interaction renders
   * floating in consumers.
   */
  mapInteractionRequested(interaction: ProjectorInteraction): TranscriptOperation[] {
    const payload = interaction.payload as { toolCallId?: unknown };
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
    const entity: TranscriptInteraction = {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      toolCallId,
      state: 'pending',
      request: interaction.payload,
    };
    this.interactions.set(interaction.id, entity);
    return [{ op: 'interaction.upsert', interaction: entity }];
  }

  /**
   * `resolved` — terminal state plus the raw engine response on the entity;
   * when the linked tool call is known, re-emit its frame with the
   * `approvalId` back-link.
   */
  mapInteractionResolved(id: string, response: unknown): TranscriptOperation[] {
    const record = this.interactions.get(id);
    if (record === undefined) return [];
    this.interactions.delete(id);
    const state = mapInteractionEndState(record.interactionKind, response);
    const ops: TranscriptOperation[] = [
      { op: 'interaction.upsert', interaction: { ...record, state, response } },
    ];
    const toolCallId = record.toolCallId;
    if (toolCallId !== undefined) {
      const hit = this.toolFrames.get(toolCallId) ?? this.adoptToolFrame(toolCallId);
      if (hit !== undefined) {
        const toolFrame: ToolCallFrame = { ...hit.frame, approvalId: id };
        this.toolFrames.set(toolCallId, { ...hit, frame: toolFrame });
        ops.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: toolFrame });
      }
    }
    return ops;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

function restOf(event: { readonly type: string; readonly time?: number }): Record<string, unknown> {
  const { type: _type, time: _time, ...rest } = event;
  return rest;
}

function mapTurnOrigin(origin: unknown): TurnOrigin {
  const candidate = origin as { kind?: unknown } | null | undefined;
  const kind = typeof candidate?.kind === 'string' ? candidate.kind : undefined;
  switch (kind) {
    case 'user':
      return { kind: 'user', payload: origin };
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (candidate as { jobId?: unknown }).jobId;
      return {
        kind: 'cron',
        taskId: typeof jobId === 'string' ? jobId : undefined,
        payload: origin,
      };
    }
    case 'task':
    case 'background_task': {
      const taskId = (candidate as { taskId?: unknown }).taskId;
      return typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'compaction_summary':
      return { kind: 'compaction', payload: origin };
    case 'shell_command':
      return { kind: 'user', payload: origin };
    default:
      return { kind: 'other', payload: origin };
  }
}

function mapTurnEndState(reason: 'completed' | 'cancelled' | 'failed' | 'blocked'): TurnState {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'blocked':
      return 'failed';
  }
}

function mapTaskKind(kind: string): TranscriptTask['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

function mapInteractionEndState(
  kind: 'approval' | 'question',
  response: unknown,
): TranscriptInteraction['state'] {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}

const TODO_LIST_TOOL_NAME = 'TodoList';
const TODO_ENTITY_ID = 'todo';

function todoWriteItems(input: unknown): TranscriptTodo['items'] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: { title: string; status: 'pending' | 'in_progress' | 'done' }[] = [];
  for (const entry of todos) {
    const title = (entry as { title?: unknown } | undefined)?.title;
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof title !== 'string') return undefined;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') return undefined;
    items.push({ title, status });
  }
  return items;
}

function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string' || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}
