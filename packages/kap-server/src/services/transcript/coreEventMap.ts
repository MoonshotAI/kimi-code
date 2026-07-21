/**
 * `AgentTranscriptProjector` — maps one agent's `IEventBus` domain events to
 * L2 transcript operations (`@moonshot-ai/transcript`).
 *
 * Mapping rules (settled design):
 *   - `turn.upsert` / `step.upsert` carry headers only; render content rides
 *     on `frame.upsert` (whole frame state) and `append` (deltas).
 *   - The turn prompt arrives on `turn.started` itself
 *     (`TurnStartedEvent.prompt`) — the context append carrying the same text
 *     is not a bus event and lands after the turn header.
 *   - Flush: at step/turn completion boundaries every open text/thinking frame
 *     of that step is re-emitted as a full-text `frame.upsert` — this is how
 *     'block'-grade subscribers (who never see `append`) reconverge.
 *   - `tool.call.delta` / `tool.progress` are NOT projected in v1 (argument and
 *     progress streaming are dropped; `tool.result` carries the terminal
 *     state). Known limitation.
 *   - `context.spliced` (undo/clear) is projected as a bare 'undo' marker with
 *     the raw payload — no `items.remove` reconstruction in v1. Known
 *     limitation.
 *   - `error` / `warning` become `marker.upsert{ marker: 'notice' }` and never
 *     enter a step.
 *   - No `swarm.*` / `plan.*` mode-transition events exist on the v2 bus today;
 *     mode badges flow from the `planMode` / `swarmMode` slices of
 *     `agent.status.updated`.
 *
 * Event payloads are typed by the core `DomainEvent` union (the
 * `DomainEventMap` augmentations in `packages/agent-core-v2/src`, e.g.
 * `agent/loop/loopService.ts`, `agent/toolExecutor/toolExecutorService.ts`,
 * `agent/task/taskOps.ts`, `agent/shellCommand/shellCommandService.ts`,
 * `session/agentLifecycle/mirrorAgentRun.ts`, `session/swarm/sessionSwarmService.ts`,
 * `agent/goal/goalOps.ts`, `agent/usage/usageOps.ts`, `agent/skill/skillOps.ts`,
 * `agent/rpc/rpcService.ts`, `session/cron/cronOps.ts`,
 * `agent/fullCompaction/compactionOps.ts`, `agent/mcp/mcpService.ts`,
 * `agent/profile/profileService.ts`, `agent/contextMemory/contextMemoryService.ts`).
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  AgentRef,
  InteractionFrame,
  StepHeader,
  TextFrame,
  ToolCallFrame,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptMarker,
  TranscriptOperation,
  TranscriptTask,
  TranscriptTodo,
  TurnHeader,
  TurnOrigin,
  TurnState,
} from '@moonshot-ai/transcript';

// ---------------------------------------------------------------------------
// Interaction view (structural — the kernel's `Interaction` narrowed to the
// two kinds the transcript renders; see
// `packages/agent-core-v2/src/session/interaction/interaction.ts`)
// ---------------------------------------------------------------------------

export interface ProjectorInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  /** In-process `ApprovalRequest` / `QuestionRequest`, passed through as-is. */
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string; readonly turnId?: number };
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

/** Optional producer-store lookups that let the projector adopt seeded state. */
export interface ProjectorLookups {
  readonly stepFrames?: ProjectorFrameLookup;
  readonly toolFrame?: ProjectorToolFrameLookup;
  readonly stepOrdinal?: ProjectorStepOrdinalLookup;
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

interface InteractionRecord {
  readonly turnId: string;
  readonly stepId: string;
  /** Legacy inline frame (kept for wire compatibility). */
  readonly frame: InteractionFrame;
  /** Global entity (authoritative channel); absent when the payload carried no toolCallId. */
  readonly interaction: TranscriptInteraction | undefined;
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
  private readonly interactions = new Map<string, InteractionRecord>();
  private markerSeq = 0;

  constructor(
    readonly agentId: string,
    private readonly lookups?: ProjectorLookups,
  ) {}

  map(event: DomainEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'turn.started':
        return this.onTurnStarted(event);
      case 'turn.ended':
        return this.onTurnEnded(event);
      case 'turn.step.started':
        return this.onStepStarted(event);
      case 'turn.step.completed':
      case 'turn.step.interrupted':
        return this.onStepFinished(event);
      case 'assistant.delta':
        return this.onTextDelta(event.turnId, 'assistant', event.delta);
      case 'thinking.delta':
        return this.onTextDelta(event.turnId, 'thinking', event.delta);
      case 'tool.call.delta':
      case 'tool.progress':
        // Known limitation: argument streaming and progress updates are not
        // projected in v1; the terminal `tool.result` carries the outcome.
        return [];
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
        // Known limitation: undo/clear projects as a bare 'undo' marker (raw
        // payload attached); no `items.remove` reconstruction in v1.
        return [this.markerOp('undo', restOf(event))];
      case 'error':
        return [this.noticeOp('error', event.message, restOf(event))];
      case 'warning':
        return [this.noticeOp('warning', event.message, restOf(event))];
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------- turn / step

  private onTurnStarted(event: {
    turnId: number;
    origin: unknown;
    prompt?: string;
  }): TranscriptOperation[] {
    const n = event.turnId;
    const turnId = `t${n}`;
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: n,
      state: 'running',
      origin: mapTurnOrigin(event.origin),
      prompt: event.prompt,
      startedAt: nowIso(),
    };
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'turn.upsert', turn: this.currentTurn }];
  }

  private onTurnEnded(event: {
    turnId: number;
    reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    // Defensive: a step left running is closed with the turn (the normal path
    // closes it via `turn.step.completed` / `turn.step.interrupted` first).
    if (this.currentStep !== undefined && this.currentStep.state === 'running') {
      const step: StepHeader = { ...this.currentStep, state: 'interrupted', endedAt: nowIso() };
      this.currentStep = step;
      ops.push({ op: 'step.upsert', turnId: step.turnId, step });
    }
    const prev = this.currentTurn?.turnId === turnId ? this.currentTurn : undefined;
    const state = mapTurnEndState(event.reason);
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: event.turnId,
      state,
      origin: prev?.origin ?? { kind: 'other' },
      prompt: prev?.prompt,
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
    };
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    this.currentStep = undefined;
    return ops;
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
    // Stray open frames from an interrupted previous step are dropped without
    // a flush — their step's own completion event owns the flush.
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private onStepFinished(event: {
    type: 'turn.step.completed' | 'turn.step.interrupted';
    turnId: number;
    step: number;
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
      state: event.type === 'turn.step.completed' ? 'completed' : 'interrupted',
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
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
    // Mid-stream attach: the backfill may have seeded this step's stream
    // frame already — adopt it instead of opening an empty one.
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
    // Known limitation: one open text frame per step per stream kind — if the
    // model emits multiple disjoint text parts in one step they are
    // concatenated into the single frame (the wire `assistant.delta` stream is
    // cumulative per turn and carries no part boundary).
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

  // ---------------------------------------------------------------- tools

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
    // A confirmed TodoList write replaces the global todo document (the frame
    // keeps its own point-in-time snapshot in `display`).
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

  // ---------------------------------------------------------------- tasks

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
      // `detached` is false while a tool call waits in the foreground; legacy
      // records omit the flag and are treated as detached (see AgentTaskInfoBase).
      detached: info.detached ?? prev?.detached ?? true,
      description: info.description,
      agentId: info.agentId ?? prev?.agentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: info.endedAt === null ? prev?.endedAt : epochMsToIso(info.endedAt),
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (event.type === 'task.started') {
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${info.taskId}`, taskId: info.taskId, at: nowIso() },
      });
    }
    return ops;
  }

  private onShellStarted(event: { commandId: string; taskId: string }): TranscriptOperation[] {
    this.shellTasks.set(event.commandId, event.taskId);
    // Known limitation: the `shell.*` payloads carry no command text (see
    // `shellCommandService.ts`), so shell-task descriptions stay empty in v1.
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
    // progress/status/custom updates carry no transcript text; only
    // stdout/stderr chunks append (see `toolUpdateSchema`).
    const text = event.update.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const ops: TranscriptOperation[] = [];
    let task = this.tasks.get(taskId);
    if (task === undefined) {
      // Seed the task so the chunk has somewhere to land (the attach missed
      // `shell.started`, and the terminal upsert would otherwise clobber the
      // output with an empty tail) — plus its timeline taskref, exactly like
      // `onShellStarted` emits.
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
      // The whole command was missed (only the completion arrived) — the
      // timeline still needs the taskref to render the task.
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

  // ---------------------------------------------------------------- subagents

  private onSubagentSpawned(event: {
    subagentId: string;
    subagentName: string;
    parentToolCallId: string;
    description?: string;
    swarmIndex?: number;
    runInBackground: boolean;
  }): TranscriptOperation[] {
    const task = this.upsertTask(event.subagentId, (prev) => ({
      taskId: event.subagentId,
      kind: 'subagent',
      state: 'running',
      // `runInBackground` subagents are detached from birth; foreground runs
      // may flip `detached` later via the task lifecycle.
      detached: event.runInBackground,
      description: event.description ?? prev?.description,
      agentId: event.subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: prev?.endedAt,
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    // Link the spawning tool call to the new agent (Agent / AgentSwarm tool
    // frames). The spawned payload carries no task id of its own — the
    // subagent task above is keyed by the agent id instead. The lookup falls
    // back to store adoption for a call that started (and was backfilled)
    // before this projector attached.
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
  }): TranscriptOperation[] {
    // The transcript task vocabulary has no 'suspended' state; a suspended
    // subagent is still alive, so it reads as 'running' (with the raw
    // suspension observable through the `subagent.suspended` WS event).
    const state: TranscriptTask['state'] =
      event.type === 'subagent.completed'
        ? 'completed'
        : event.type === 'subagent.failed'
          ? 'failed'
          : 'running';
    const task = this.upsertTask(event.subagentId, (prev) => ({
      taskId: event.subagentId,
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
    }));
    return [{ op: 'task.upsert', task }];
  }

  // ---------------------------------------------------------------- goal / modes / markers

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
    if (snapshot !== null) {
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
    // Known limitation: a cleared goal (`snapshot: null`) cannot be expressed
    // by `meta.merge` (absent keys keep prior state) — the 'goal' marker
    // lands, and `meta.goal` refreshes on the next reset.
    ops.push(this.markerOp('goal', restOf(event)));
    return ops;
  }

  private onAgentStatusUpdated(event: {
    planMode?: boolean;
    swarmMode?: boolean;
  }): TranscriptOperation[] {
    // Only the exact `planMode` / `swarmMode` fields are projected (the status
    // slices arrive independently — see `agent/usage/usageOps.ts`). A mode
    // exit (`false`) clears the badge: `null` deletes the key in the reducer,
    // so clients never keep showing a mode that already ended.
    const modes: { plan?: Record<string, never> | null; swarm?: Record<string, never> | null } = {};
    if (event.planMode === true) modes.plan = {};
    else if (event.planMode === false) modes.plan = null;
    if (event.swarmMode === true) modes.swarm = {};
    else if (event.swarmMode === false) modes.swarm = null;
    if (modes.plan === undefined && modes.swarm === undefined) return [];
    return [{ op: 'meta.merge', meta: { modes } }];
  }

  private markerOp(marker: string, payload: unknown): TranscriptOperation {
    this.markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      // Live markers use their own namespace: the cold rebuild numbers its
      // markers `m1…` from zero too, and a colliding id would make the
      // store's upsert REPLACE the historical marker with the live one (or
      // vice versa) instead of appending.
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

  // ---------------------------------------------------------------- interactions

  /**
   * `requested` — dual emission, by wire-compat contract:
   *  - legacy: an inline `InteractionFrame` placed next to the tool call that
   *    gated it (fallback: the turn's latest step), exactly as older
   *    consumers read it;
   *  - authoritative: the global interaction entity (`interaction.upsert`),
   *    addressed by id, pagination-proof, visible at 'turn' grade.
   * Both mirror the same interaction by `interactionId`; the entity's
   * `toolCallId` is required (approvals gate a tool call; questions are
   * emitted by the AskUserQuestion tool call itself), so a payload without
   * one still produces the legacy frame (fallback placement) but no entity.
   */
  mapInteractionRequested(interaction: ProjectorInteraction): TranscriptOperation[] {
    const payload = interaction.payload as { toolCallId?: unknown; turnId?: unknown };
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
    // A mid-bind request adopts the seeded tool frame from the store first
    // (the call started before this projector attached).
    const hit =
      toolCallId !== undefined
        ? (this.toolFrames.get(toolCallId) ?? this.adoptToolFrame(toolCallId))
        : undefined;
    let turnId: string;
    let stepId: string;
    if (hit !== undefined) {
      ({ turnId, stepId } = hit);
    } else {
      const turnNumber =
        interaction.origin.turnId ??
        (typeof payload.turnId === 'number' ? payload.turnId : undefined) ??
        (this.currentTurn !== undefined ? this.currentTurn.ordinal : 1);
      turnId = `t${turnNumber}`;
      stepId = `${turnId}.${this.stepOrdinals.get(turnId) ?? 1}`;
    }
    const frame: InteractionFrame = {
      kind: 'interaction',
      frameId: `i-${interaction.id}`,
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      toolCallId,
      state: 'pending',
      request: interaction.payload,
    };
    const ops: TranscriptOperation[] = [{ op: 'frame.upsert', turnId, stepId, frame }];
    let entity: TranscriptInteraction | undefined;
    if (toolCallId !== undefined) {
      entity = {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        toolCallId,
        state: 'pending',
        request: interaction.payload,
      };
      ops.push({ op: 'interaction.upsert', interaction: entity });
    }
    this.interactions.set(interaction.id, { turnId, stepId, frame, interaction: entity });
    return ops;
  }

  /**
   * `resolved` — terminal state plus the raw engine response on BOTH channels
   * (legacy frame and entity); when the linked tool call is known, re-emit
   * its frame with the `approvalId` back-link.
   */
  mapInteractionResolved(id: string, response: unknown): TranscriptOperation[] {
    const record = this.interactions.get(id);
    if (record === undefined) return [];
    this.interactions.delete(id);
    const state = mapInteractionEndState(record.frame.interactionKind, response);
    const frame: InteractionFrame = { ...record.frame, state, response };
    const ops: TranscriptOperation[] = [
      { op: 'frame.upsert', turnId: record.turnId, stepId: record.stepId, frame },
    ];
    if (record.interaction !== undefined) {
      ops.push({
        op: 'interaction.upsert',
        interaction: { ...record.interaction, state, response },
      });
    }
    const toolCallId = record.frame.toolCallId;
    if (toolCallId !== undefined) {
      // Adopt the seeded frame when the call predates this projector, so the
      // back-link still lands after a mid-bind attach.
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

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

/** Event payload without the `type` discriminant (markers carry it verbatim). */
function restOf(event: { readonly type: string }): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest;
}

/**
 * Engine `PromptOrigin` → transcript `TurnOrigin` (mirrors the cold-path
 * `groupMessagesIntoSnapshot` origin mapping; payload kept verbatim).
 */
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
      // `!shell` echoes are user-visible input (same treatment as the cold path).
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
      // The engine folds `blocked` into `failed` at the wire edge (see
      // `TurnEndReason`); the transcript mirrors that contract.
      return 'failed';
  }
}

/** Engine task kinds (`AgentTaskInfoByKind`: process / agent / question) → transcript kinds. */
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

/** Engine todo tool name and the singleton todo entity id (the engine store key). */
const TODO_LIST_TOOL_NAME = 'TodoList';
const TODO_ENTITY_ID = 'todo';

/** TodoList write args → todo items; undefined when the call is a read or malformed. */
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

/** Tool args arrive parsed in v2; tolerate a raw JSON string (parse-or-keep). */
function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string' || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}
