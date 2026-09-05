import {
  daemonFileRefFromPart,
  readTodoItems,
  type AgentTaskInfo,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';

import type {
  AssistantMessage,
  InteractionMessage,
  ServerMessage,
  StepMessage,
  StepRetry,
  StepTiming,
  StepUsage,
  SystemMessage,
  TaskMessage,
  TaskNotificationPayload,
  ThinkingMessage,
  TodoMessage,
  ToolCallAgentRef,
  ToolCallMessage,
  ToolProgressPayload,
  TurnMessage,
  TurnOrigin,
  UserMessage,
  UserMessageOrigin,
} from '../../protocol/messages';
import { PROJECTION_IGNORED_EVENT_TYPES, type ProjectionBusEvent } from './events';
import type { WireTurnFold } from './heal';
import {
  SystemIdAllocator,
  TODO_ENTITY_ID,
  attachmentIdOf,
  isCompactionSystemId,
  isUndoAnchorOrigin,
  stepIdOf,
  stepUserMessageIdOf,
  textMessageIdOf,
  turnIdOf,
  turnOrdinalOf,
  turnUserMessageIdOf,
} from './ids';

const TASK_OUTPUT_TAIL_MAX = 8192;
const PENDING_CLEAR_SETTLE_MS = 100;

export interface ProjectorInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string; readonly turnId?: number };
  readonly createdAt: number;
}

export interface ProjectorLookups {
  readonly stepOrdinal?: (turnId: string) => number | undefined;
  readonly resolvePlanRevisionKey?: (key: string) => string;
}

export interface ProjectorHooks {
  readonly onUnknownEvent?: (type: string) => void;
  readonly onDeferred?: (messages: ServerMessage[]) => void;
}

interface TurnRecord {
  turnId: string;
  ordinal: number;
  state: 'running' | 'completed';
  origin: TurnOrigin;
  anchor: boolean;
  promptId?: string;
  userMessageId?: string;
  attachmentIds?: string[];
  openingKey?: { text: string; attachments: number };
  openingSteerDeduped: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  usage?: StepUsage;
}

interface StepRecord {
  stepId: string;
  turnId: string;
  ordinal: number;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt?: string;
  endedAt?: string;
  usage?: StepUsage;
  finishReason?: string;
  timing?: StepTiming;
  retry?: StepRetry;
  endReason?: string;
  endMessage?: string;
}

interface TextRecord {
  messageId: string;
  kind: 'assistant' | 'thinking';
  turnId: string;
  stepId: string;
  status: 'streaming' | 'completed';
  text: string;
}

interface ToolRecord {
  toolCallId: string;
  turnId: string;
  stepId: string;
  name: string;
  state: 'running' | 'done' | 'error';
  input?: unknown;
  inputText?: string;
  output?: unknown;
  display?: unknown;
  error?: string;
  progress?: ToolProgressPayload;
  taskId?: string;
  approvalId?: string;
  todoId?: string;
  agentRefs: ToolCallAgentRef[];
  startedAt?: string;
}

interface TaskRecord {
  taskId: string;
  kind: TaskMessage['kind'];
  state: TaskMessage['state'];
  detached: boolean;
  description?: string;
  childAgentId?: string;
  outputTail: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
  stateReason?: string;
  usage?: StepUsage;
  model?: string;
  thinkingEffort?: string;
}

interface InteractionRecord {
  interactionId: string;
  kind: 'approval' | 'question';
  state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  toolCallId?: string;
  request?: unknown;
  response?: unknown;
}

interface UserRecord {
  messageId: string;
  turnId: string;
  stepId?: string;
  promptId?: string;
  text: string;
  status: 'running' | 'completed';
  createdAt: string;
  finishedAt?: string;
  steeredAt?: string;
  origin?: UserMessageOrigin;
  notification?: TaskNotificationPayload;
  attachmentIds?: string[];
  skillActivations?: { skill_name: string; skill_args?: string }[];
}

interface PromptRecord {
  promptId: string;
  text: string;
  status: 'running' | 'queued' | 'completed' | 'aborted';
  createdAt: string;
  turnId?: string;
  messageId?: string;
  predicted?: boolean;
}

interface PendingSteer {
  readonly input: readonly ContentPart[];
  readonly origin: UserMessageOrigin | undefined;
  readonly skillActivations: { skill_name: string; skill_args?: string }[] | undefined;
  readonly skipBlocks: number;
  readonly at: string;
  readonly notification?: { readonly payload: TaskNotificationPayload; readonly text: string };
}

export class AgentMessageProjector {
  private currentTurn: TurnRecord | undefined;
  private currentStep: StepRecord | undefined;
  private openText: TextRecord | undefined;
  private openThinking: TextRecord | undefined;
  private userSeq = 0;
  private attachmentSeq = 0;
  private phantomUserSeq = 0;
  private readonly turns = new Map<string, TurnRecord>();
  private readonly steps = new Map<string, StepRecord>();
  private readonly texts = new Map<string, TextRecord>();
  private readonly stepTextIds = new Map<string, { assistant?: string; thinking?: string }>();
  private readonly stepTextSeqs = new Map<string, number>();
  private readonly tools = new Map<string, ToolRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly shellTasks = new Map<string, string>();
  private readonly interactions = new Map<string, InteractionRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly prompts = new Map<string, PromptRecord>();
  private readonly stepOrdinals = new Map<string, number>();
  private readonly stepUsageByTurn = new Map<string, StepUsage[]>();
  private pendingSteers: PendingSteer[] = [];
  private pendingFullCut = false;
  private pendingClearTimer: NodeJS.Timeout | undefined;
  private todoItems: { title: string; status: 'pending' | 'in_progress' | 'done' }[] | undefined;
  private todoUpdatedAt: string | undefined;
  private planMode = false;
  private swarmMode = false;
  private readonly timelineIds: string[] = [];
  private readonly sysIds = new SystemIdAllocator();
  private readonly endedTurnOrdinals: number[] = [];
  private readonly anchorTurnOrdinals = new Set<number>();
  private timelineRewriteCount = 0;
  private nextTurnIdHint = 0;
  private queuedTurnIdCursor: number | undefined;

  constructor(
    readonly agentId: string,
    private readonly sessionId: string,
    private readonly subagentTaskIds: Map<string, string>,
    private readonly lookups?: ProjectorLookups,
    private readonly hooks?: ProjectorHooks,
  ) {}

  map(event: ProjectionBusEvent): ServerMessage[] {
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
        return this.onStepInterrupted(event);
      case 'turn.step.retrying':
        return this.onStepRetrying(event);
      case 'assistant.delta':
        return this.onTextDelta(event, 'assistant');
      case 'thinking.delta':
        return this.onTextDelta(event, 'thinking');
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
      case 'shell.started':
        return this.onShellStarted(event);
      case 'shell.output':
        return this.onShellOutput(event);
      case 'shell.completed':
        return this.onShellCompleted(event);
      case 'subagent.spawned':
        return this.onSubagentSpawned(event);
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.suspended':
        return this.onSubagentRun(event);
      case 'goal.updated':
        return this.onGoalUpdated(event);
      case 'agent.status.updated':
        return this.onAgentStatusUpdated(event);
      case 'agent.activity.updated':
        return [];
      case 'prompt.submitted':
        return this.onPromptSubmitted(event);
      case 'prompt.queued':
        return this.onPromptQueued(event);
      case 'prompt.started':
        return this.onPromptStarted(event);
      case 'prompt.completed':
        return this.onPromptCompleted(event);
      case 'prompt.aborted':
        return this.onPromptAborted(event);
      case 'prompt.steered':
        return this.onPromptSteered(event);
      case 'turn.steer':
        return this.onTurnSteered(event);
      case 'hook.result':
        return [this.systemOp('hook', hookPayload(event), event.time)];
      case 'skill.activated':
        return [this.systemOp('skill', skillPayload(event), event.time)];
      case 'plugin_command.activated':
        return [
          this.systemOp(
            'skill',
            { ...skillPayload(event), variant: 'plugin_command' },
            event.time,
          ),
        ];
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
        return [];
      case 'compaction.completed': {
        const result = event.result;
        const text =
          result.summary.length > 0 ? result.summary : result.contextSummary;
        return [
          this.systemOp(
            'compaction',
            { phase: 'completed', text: text !== undefined && text.length > 0 ? text : undefined },
            event.time,
          ),
        ];
      }
      case 'context.spliced':
        return this.onContextSpliced(event);
      case 'context.undone':
        return this.onContextUndone(event);
      case 'error':
        return [
          this.systemOp(
            'notice',
            { level: 'error', message: event.message, ...restOf(event) },
            event.time,
          ),
        ];
      case 'warning':
        return [
          this.systemOp(
            'notice',
            { level: 'warning', message: event.message, code: event.code },
            event.time,
          ),
        ];
      case 'prompt.accepted':
      case 'cron.fired':
      case 'permission.approval.requested':
      case 'permission.approval.resolved':
      case 'subagent.started':
        return [];
      case 'task.notified':
        return this.onTaskNotified(event);
      default: {
        const type = (event as { type: string }).type;
        if (PROJECTION_IGNORED_EVENT_TYPES.has(type)) return [];
        this.hooks?.onUnknownEvent?.(type);
        return [];
      }
    }
  }

  seedActiveTurn(info: {
    turnId: number;
    promptId?: string;
    origin?: TurnOrigin;
    anchor?: boolean;
  }): void {
    const turnId = turnIdOf(info.turnId);
    this.noteTurnId(info.turnId);
    if (info.anchor === true) this.anchorTurnOrdinals.add(info.turnId);
    this.currentTurn = {
      turnId,
      ordinal: info.turnId,
      state: 'running',
      origin: info.origin ?? { kind: 'other' },
      anchor: info.anchor === true,
      promptId: info.promptId,
      userMessageId: info.promptId === undefined ? undefined : turnUserMessageIdOf(turnId),
      openingSteerDeduped: false,
    };
    this.turns.set(turnId, this.currentTurn);
    this.timelineIds.push(turnId);
  }

  seedTask(info: AgentTaskInfo): ServerMessage[] {
    if (info.status !== 'running') return [];
    const agentInfo = agentInfoOf(info);
    const kind = mapTaskKind(info.kind);
    const task = this.upsertTask(info.taskId, (prev) => ({
      taskId: info.taskId,
      kind,
      state: 'running',
      detached: info.detached ?? prev?.detached ?? kind !== 'shell',
      description: info.description,
      childAgentId: agentInfo?.agentId ?? prev?.childAgentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      model: agentInfo?.model ?? prev?.model,
      thinkingEffort: agentInfo?.thinkingEffort ?? prev?.thinkingEffort,
    }));
    const childAgentId = agentInfo?.agentId;
    if (info.kind === 'agent' && typeof childAgentId === 'string' && childAgentId.length > 0) {
      this.subagentTaskIds.set(childAgentId, info.taskId);
    }
    return [this.taskOp(task)];
  }

  seedTodo(
    items: readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[],
  ): ServerMessage[] {
    if (items.length === 0) return [];
    this.todoItems = items.map((item) => ({ title: item.title, status: item.status }));
    this.todoUpdatedAt = undefined;
    return [this.todoOp()];
  }

  taskOutputUpdated(taskId: string, outputTail: string): ServerMessage[] {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.outputTail === outputTail) return [];
    task.outputTail = outputTail;
    return [this.taskOp(task)];
  }

  seedModes(modes: { planMode?: boolean; swarmMode?: boolean }): void {
    if (modes.planMode !== undefined) this.planMode = modes.planMode;
    if (modes.swarmMode !== undefined) this.swarmMode = modes.swarmMode;
  }

  todoChanged(
    items: readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[],
  ): ServerMessage[] {
    this.todoItems = items.map((item) => ({ title: item.title, status: item.status }));
    this.todoUpdatedAt = nowIso();
    return [this.todoOp()];
  }

  interactionRequested(interaction: ProjectorInteraction): ServerMessage[] {
    const payload = interaction.payload as Record<string, unknown> | null;
    const toolCallId =
      typeof payload?.['toolCallId'] === 'string' ? payload['toolCallId'] : undefined;
    const record: InteractionRecord = {
      interactionId: interaction.id,
      kind: interaction.kind,
      state: 'pending',
      toolCallId,
      request: this.wireInteractionRequest(interaction),
    };
    this.interactions.set(interaction.id, record);
    const ops: ServerMessage[] = [this.interactionOp(record)];
    if (toolCallId !== undefined) {
      const tool = this.tools.get(toolCallId);
      if (tool !== undefined && tool.approvalId !== interaction.id) {
        tool.approvalId = interaction.id;
        ops.push(this.toolOp(tool));
      }
    }
    return ops;
  }

  interactionResolved(id: string, response: unknown): ServerMessage[] {
    const record = this.interactions.get(id);
    if (record === undefined) return [];
    record.state = mapInteractionEndState(record.kind, response);
    record.response = this.wireInteractionResponse(record, response);
    return [this.interactionOp(record)];
  }

  recoveryMessages(): ServerMessage[] {
    const ops: ServerMessage[] = [];
    const turn = this.currentTurn;
    if (turn !== undefined && turn.state === 'running') {
      ops.push(this.turnOp(turn));
      const step = this.currentStep;
      const replayStepId =
        step !== undefined && step.turnId === turn.turnId ? step.stepId : undefined;
      if (step !== undefined && replayStepId !== undefined) {
        ops.push(this.stepOp(step));
        for (const record of this.texts.values()) {
          if (record.stepId === replayStepId) ops.push(this.textOp(record));
        }
      }
      for (const tool of this.tools.values()) {
        if (tool.turnId !== turn.turnId) continue;
        if (tool.state === 'running' || tool.stepId === replayStepId) ops.push(this.toolOp(tool));
      }
    }
    for (const record of this.interactions.values()) {
      if (record.state === 'pending') ops.push(this.interactionOp(record));
    }
    for (const task of this.tasks.values()) {
      if (task.state === 'running') ops.push(this.taskOp(task));
    }
    if (this.todoItems !== undefined) ops.push(this.todoOp());
    return ops;
  }

  notifyContextCleared(): ServerMessage[] {
    this.cancelPendingClearTimer();
    this.pendingFullCut = false;
    return this.applyClear();
  }

  applyTimelineSeed(seed: {
    timelineIds: readonly string[];
    systemCounts: ReadonlyMap<string, number>;
    anchorTurnOrdinals: readonly number[];
    nextTurnId: number;
  }): void {
    if (this.timelineRewriteCount > 0) return;
    const existing = new Set(this.timelineIds);
    this.timelineIds.unshift(...seed.timelineIds.filter((id) => !existing.has(id)));
    for (const [subtype, count] of seed.systemCounts) this.sysIds.seed(subtype, count);
    for (const ordinal of seed.anchorTurnOrdinals) this.anchorTurnOrdinals.add(ordinal);
    this.nextTurnIdHint = Math.max(this.nextTurnIdHint, seed.nextTurnId);
  }

  dispose(): void {
    this.cancelPendingClearTimer();
  }

  private noteTurnId(turnId: number): void {
    this.nextTurnIdHint = Math.max(this.nextTurnIdHint, turnId + 1);
  }

  takeEndedTurnOrdinals(): number[] {
    return this.endedTurnOrdinals.splice(0);
  }

  healTurn(ordinal: number, fold: WireTurnFold): ServerMessage[] {
    const turnId = turnIdOf(ordinal);
    const held = this.turns.get(turnId);
    if (held?.state !== 'completed') return [];
    const ops: ServerMessage[] = [];
    const stepOrdinals = new Set<number>([...fold.steps.keys(), ...fold.texts.keys()]);
    for (const wireTool of fold.tools.values()) stepOrdinals.add(wireTool.step);
    for (const stepOrdinal of [...stepOrdinals].toSorted((a, b) => a - b)) {
      const wireStep = fold.steps.get(stepOrdinal);
      const stepId = stepIdOf(turnId, stepOrdinal);
      const live = this.steps.get(stepId);
      if (live === undefined) {
        const step: StepRecord = {
          stepId,
          turnId,
          ordinal: stepOrdinal,
          state: wireStep?.state ?? 'interrupted',
          endedAt: wireStep?.endedAt,
          usage: wireStep?.usage,
          finishReason: wireStep?.finishReason,
          timing: wireStep?.timing,
          endReason: wireStep?.endReason,
          endMessage: wireStep?.endMessage,
        };
        this.steps.set(stepId, step);
        this.stepOrdinals.set(turnId, Math.max(this.stepOrdinals.get(turnId) ?? 0, stepOrdinal));
        ops.push(this.stepOp(step));
      } else if (live.state === 'running' && wireStep !== undefined) {
        live.state = wireStep.state;
        live.endedAt = wireStep.endedAt;
        live.usage = live.usage ?? wireStep.usage;
        live.finishReason = live.finishReason ?? wireStep.finishReason;
        live.timing = live.timing ?? wireStep.timing;
        live.endReason = live.endReason ?? wireStep.endReason;
        live.endMessage = live.endMessage ?? wireStep.endMessage;
        ops.push(this.stepOp(live));
      }
      const wireTexts = fold.texts.get(stepOrdinal);
      if (wireTexts !== undefined) {
        ops.push(...this.healStepTexts(stepId, turnId, wireTexts));
      }
    }
    for (const [toolCallId, wireTool] of fold.tools) {
      const live = this.tools.get(toolCallId);
      const stepId = stepIdOf(turnId, wireTool.step);
      if (live === undefined) {
        const tool: ToolRecord = {
          toolCallId,
          turnId,
          stepId,
          name: wireTool.name,
          state: wireTool.isError === true ? 'error' : 'done',
          input: parseToolArgs(wireTool.args),
          inputText: typeof wireTool.args === 'string' ? wireTool.args : undefined,
          output: wireTool.output,
          error:
            wireTool.isError === true && typeof wireTool.output === 'string'
              ? wireTool.output
              : undefined,
          agentRefs: [],
        };
        this.tools.set(toolCallId, tool);
        ops.push(this.toolOp(tool));
        continue;
      }
      const liveHasOutcome =
        live.output !== undefined || live.error !== undefined || live.state !== 'running';
      const wireHasOutcome = wireTool.output !== undefined || wireTool.isError === true;
      if (liveHasOutcome || !wireHasOutcome) continue;
      live.state = wireTool.isError === true ? 'error' : 'done';
      live.output = wireTool.output;
      live.error =
        wireTool.isError === true && typeof wireTool.output === 'string'
          ? wireTool.output
          : undefined;
      ops.push(this.toolOp(live));
    }
    this.dropTurnDetails(turnId);
    return ops;
  }

  inFlight(): { turn_id: string; step_id: string } | undefined {
    const turn = this.currentTurn;
    const step = this.currentStep;
    if (turn === undefined || step === undefined) return undefined;
    if (turn.state !== 'running' || step.turnId !== turn.turnId) return undefined;
    return { turn_id: turn.turnId, step_id: step.stepId };
  }

  private healStepTexts(
    stepId: string,
    turnId: string,
    wireTexts: { assistant: string; thinking: string; first: 'assistant' | 'thinking' },
  ): ServerMessage[] {
    const ops: ServerMessage[] = [];
    const kinds: readonly ('assistant' | 'thinking')[] =
      wireTexts.first === 'thinking' ? ['thinking', 'assistant'] : ['assistant', 'thinking'];
    for (const kind of kinds) {
      const wireText = kind === 'assistant' ? wireTexts.assistant : wireTexts.thinking;
      const liveId = this.stepTextIds.get(stepId)?.[kind];
      const live = liveId === undefined ? undefined : this.texts.get(liveId);
      if (live === undefined) {
        if (wireText.length === 0) continue;
        const record = this.createTextRecord(stepId, turnId, kind);
        record.text = wireText;
        record.status = 'completed';
        ops.push(this.textOp(record));
        continue;
      }
      if (wireText.length > live.text.length) {
        live.text = wireText;
        live.status = 'completed';
        ops.push(this.textOp(live));
      }
    }
    return ops;
  }

  private onTurnStarted(event: {
    time: number;
    turnId: number;
    promptId?: string;
    origin: unknown;
    prompt?: string;
    promptAttachments?: readonly unknown[];
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    if (this.currentTurn !== undefined && this.currentTurn.state === 'running') {
      ops.push(...this.finalizeTurn(this.currentTurn, event.time));
    }
    const turnId = turnIdOf(event.turnId);
    this.noteTurnId(event.turnId);
    this.phantomUserSeq = 0;
    const origin = this.mapTurnOrigin(event.origin);
    const attachments = event.promptAttachments ?? [];
    const attachmentIds = attachments.map((_, index) => attachmentIdOf(turnId, index + 1));
    const promptRecord = event.promptId === undefined ? undefined : this.prompts.get(event.promptId);
    const promptText = event.prompt ?? promptRecord?.text;
    if (
      promptRecord?.messageId !== undefined &&
      promptRecord.turnId !== undefined &&
      promptRecord.turnId !== turnId
    ) {
      const stale = this.users.get(promptRecord.messageId);
      if (stale !== undefined && stale.status === 'running') {
        stale.status = 'completed';
        stale.finishedAt = epochMsToIso(event.time);
        ops.push(this.userOp(stale));
      }
      promptRecord.turnId = undefined;
      promptRecord.messageId = undefined;
    }
    const wantsUser = wantsUserMessage(event.origin, promptText);
    if (promptRecord !== undefined) promptRecord.predicted = false;
    const anchor = isUndoAnchorOrigin(event.origin);
    if (anchor) this.anchorTurnOrdinals.add(event.turnId);
    const turn: TurnRecord = {
      turnId,
      ordinal: event.turnId,
      state: 'running',
      origin,
      anchor,
      promptId: event.promptId,
      userMessageId: wantsUser ? turnUserMessageIdOf(turnId) : undefined,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      openingKey: { text: promptText ?? '', attachments: attachmentIds.length },
      openingSteerDeduped: false,
      startedAt: epochMsToIso(event.time),
    };
    this.currentTurn = turn;
    this.turns.set(turnId, turn);
    this.timelineIds.push(turnId);
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    this.pendingSteers = [];
    ops.push(this.turnOp(turn));
    if (wantsUser && turn.userMessageId !== undefined) {
      const user: UserRecord = {
        messageId: turn.userMessageId,
        turnId,
        promptId: event.promptId,
        text: promptText ?? '',
        status: 'running',
        createdAt: promptRecord?.createdAt ?? epochMsToIso(event.time),
        origin: userOriginOf(event.origin),
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        skillActivations: skillActivationsOf(event.origin),
      };
      this.users.set(user.messageId, user);
      if (promptRecord !== undefined) {
        promptRecord.turnId = turnId;
        promptRecord.messageId = user.messageId;
      }
      ops.push(this.userOp(user));
    }
    return ops;
  }

  private onTurnEnded(event: {
    time: number;
    turnId: number;
    reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    durationMs?: number;
    interruptReason?: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const turnId = turnIdOf(event.turnId);
    const turn = this.currentTurn?.turnId === turnId ? this.currentTurn : this.turns.get(turnId);
    if (turn === undefined) return ops;
    ops.push(...this.finalizeTurn(turn, event.time, event.reason, event.durationMs));
    this.currentStep = undefined;
    if (this.currentTurn?.turnId === turnId) this.currentTurn = undefined;
    this.endedTurnOrdinals.push(event.turnId);
    if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
      ops.push(
        this.systemOp(
          'interruption',
          { turn_id: turnId, reason: event.interruptReason },
          event.time,
        ),
      );
    }
    return ops;
  }

  private finalizeTurn(
    turn: TurnRecord,
    time: number,
    reason?: 'completed' | 'cancelled' | 'failed' | 'blocked',
    durationMs?: number,
  ): ServerMessage[] {
    const ops = this.flushOpenTexts();
    const turnId = turn.turnId;
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      const step = this.currentStep;
      if (step.state === 'running') {
        step.state = reason === 'failed' || reason === 'blocked' ? 'failed' : 'interrupted';
        step.endedAt = epochMsToIso(time);
        ops.push(this.stepOp(step));
      }
    } else if (this.pendingSteers.length > 0) {
      const ordinal = (this.stepOrdinals.get(turnId) ?? this.lookups?.stepOrdinal?.(turnId) ?? 0) + 1;
      const step: StepRecord = {
        stepId: stepIdOf(turnId, ordinal),
        turnId,
        ordinal,
        state: 'interrupted',
        endedAt: epochMsToIso(time),
      };
      this.stepOrdinals.set(turnId, ordinal);
      this.steps.set(step.stepId, step);
      this.currentStep = step;
      ops.push(this.stepOp(step));
    }
    const step = this.currentStep;
    if (step !== undefined && step.turnId === turnId && this.pendingSteers.length > 0) {
      for (const pending of this.pendingSteers) {
        ops.push(this.steerUserMessage(step, pending));
      }
    }
    this.pendingSteers = [];
    turn.state = 'completed';
    turn.endedAt = epochMsToIso(time);
    turn.durationMs = durationMs;
    turn.usage = this.takeTurnUsage(turnId);
    for (const user of this.users.values()) {
      if (user.turnId !== turnId || user.status !== 'running') continue;
      user.status = 'completed';
      user.finishedAt = epochMsToIso(time);
      ops.push(this.userOp(user));
    }
    ops.push(this.turnOp(turn));
    return ops;
  }

  private takeTurnUsage(turnId: string): StepUsage | undefined {
    const usages = this.stepUsageByTurn.get(turnId);
    this.stepUsageByTurn.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    let inputOther = 0;
    let output = 0;
    let inputCacheRead = 0;
    let inputCacheCreation = 0;
    for (const usage of usages) {
      inputOther += usage.input_other;
      output += usage.output;
      inputCacheRead += usage.input_cache_read;
      inputCacheCreation += usage.input_cache_creation;
    }
    return {
      input_other: inputOther,
      output,
      input_cache_read: inputCacheRead,
      input_cache_creation: inputCacheCreation,
    };
  }

  private onStepStarted(event: { time: number; turnId: number; step: number }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const turnId = turnIdOf(event.turnId);
    if (this.currentStep !== undefined && this.currentStep.state === 'running') {
      ops.push(...this.flushOpenTexts());
      this.currentStep.state = 'completed';
      this.currentStep.endedAt = epochMsToIso(event.time);
      ops.push(this.stepOp(this.currentStep));
    }
    const stepId = stepIdOf(turnId, event.step);
    this.stepOrdinals.set(turnId, event.step);
    const step: StepRecord = {
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: epochMsToIso(event.time),
    };
    this.currentStep = step;
    this.steps.set(stepId, step);
    this.userSeq = 0;
    this.attachmentSeq = 0;
    this.openText = undefined;
    this.openThinking = undefined;
    ops.push(this.stepOp(step));
    for (const pending of this.pendingSteers) {
      ops.push(this.steerUserMessage(step, pending));
    }
    this.pendingSteers = [];
    return ops;
  }

  private onStepCompleted(event: {
    time: number;
    turnId: number;
    step: number;
    usage?: TokenUsage;
    finishReason?: string;
    rawFinishReason?: string;
    providerFinishReason?: string;
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    ops.push(...this.flushOpenTexts());
    const turnId = turnIdOf(event.turnId);
    const stepId = stepIdOf(turnId, event.step);
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : this.steps.get(stepId);
    const usage = event.usage === undefined ? undefined : toSnakeUsage(event.usage);
    if (usage !== undefined) {
      const usages = this.stepUsageByTurn.get(turnId) ?? [];
      usages.push(usage);
      this.stepUsageByTurn.set(turnId, usages);
    }
    const step: StepRecord = {
      stepId,
      turnId,
      ordinal: event.step,
      state: 'completed',
      startedAt: prev?.startedAt,
      endedAt: epochMsToIso(event.time),
      usage,
      finishReason: event.finishReason ?? event.rawFinishReason ?? event.providerFinishReason,
      timing: timingOf(event),
    };
    this.currentStep = step;
    this.steps.set(stepId, step);
    ops.push(this.stepOp(step));
    return ops;
  }

  private onStepInterrupted(event: {
    time: number;
    turnId: number;
    step: number;
    reason: string;
    message?: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    ops.push(...this.flushOpenTexts());
    const turnId = turnIdOf(event.turnId);
    const stepId = stepIdOf(turnId, event.step);
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : this.steps.get(stepId);
    const step: StepRecord = {
      stepId,
      turnId,
      ordinal: event.step,
      state: 'interrupted',
      startedAt: prev?.startedAt,
      endedAt: epochMsToIso(event.time),
      endReason: event.reason,
      endMessage: event.message,
    };
    this.currentStep = step;
    this.steps.set(stepId, step);
    ops.push(this.stepOp(step));
    return ops;
  }

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
  }): ServerMessage[] {
    const turnId = turnIdOf(event.turnId);
    const stepId = stepIdOf(turnId, event.step);
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : this.steps.get(stepId);
    const step: StepRecord = {
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: prev?.startedAt,
      retry: {
        failed_attempt: event.failedAttempt,
        next_attempt: event.nextAttempt,
        max_attempts: event.maxAttempts,
        delay_ms: event.delayMs,
        error_name: event.errorName,
        error_message: event.errorMessage,
        status_code: event.statusCode,
      },
    };
    this.currentStep = step;
    this.steps.set(stepId, step);
    return [this.stepOp(step)];
  }

  private onTextDelta(
    event: { time: number; turnId: number; delta: string },
    kind: 'assistant' | 'thinking',
  ): ServerMessage[] {
    const ops = this.settlePendingClear();
    const turnId = turnIdOf(event.turnId);
    this.ensureTurn(turnId, event.time, ops);
    const step = this.ensureStep(turnId, event.time, ops);
    let open = kind === 'assistant' ? this.openText : this.openThinking;
    if (open === undefined || open.stepId !== step.stepId) {
      open = this.createTextRecord(step.stepId, turnId, kind);
      if (kind === 'assistant') this.openText = open;
      else this.openThinking = open;
      ops.push(this.textOp(open));
    }
    open.text += event.delta;
    ops.push(this.textDeltaOp(open, event.delta));
    return ops;
  }

  private flushOpenTexts(): ServerMessage[] {
    const ops: ServerMessage[] = [];
    for (const open of [this.openText, this.openThinking]) {
      if (open === undefined) continue;
      open.status = 'completed';
      ops.push(this.textOp(open));
    }
    this.openText = undefined;
    this.openThinking = undefined;
    return ops;
  }

  private ensureTurn(turnId: string, time: number, ops: ServerMessage[]): TurnRecord {
    if (this.currentTurn !== undefined && this.currentTurn.turnId === turnId) {
      return this.currentTurn;
    }
    const ordinal = turnOrdinalOf(turnId) ?? 0;
    this.noteTurnId(ordinal);
    const turn: TurnRecord = {
      turnId,
      ordinal,
      state: 'running',
      origin: { kind: 'other' },
      anchor: false,
      openingSteerDeduped: false,
      startedAt: epochMsToIso(time),
    };
    this.currentTurn = turn;
    this.turns.set(turnId, turn);
    this.timelineIds.push(turnId);
    ops.push(this.turnOp(turn));
    return turn;
  }

  private ensureStep(turnId: string, time: number, ops: ServerMessage[]): StepRecord {
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      return this.currentStep;
    }
    const ordinal = this.lookups?.stepOrdinal?.(turnId) ?? this.stepOrdinals.get(turnId) ?? 1;
    const step: StepRecord = {
      stepId: stepIdOf(turnId, ordinal),
      turnId,
      ordinal,
      state: 'running',
      startedAt: epochMsToIso(time),
    };
    this.stepOrdinals.set(turnId, ordinal);
    this.currentStep = step;
    this.steps.set(step.stepId, step);
    ops.push(this.stepOp(step));
    return step;
  }

  private onToolCallDelta(event: {
    time: number;
    turnId: number;
    toolCallId: string;
    name?: string;
    argumentsPart?: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const prev = this.tools.get(event.toolCallId);
    if (prev !== undefined) {
      prev.inputText = (prev.inputText ?? '') + (event.argumentsPart ?? '');
      ops.push(this.toolDeltaOp(event.toolCallId, event.argumentsPart ?? ''));
      return ops;
    }
    const turnId = turnIdOf(event.turnId);
    this.ensureTurn(turnId, event.time, ops);
    const step = this.ensureStep(turnId, event.time, ops);
    const tool: ToolRecord = {
      toolCallId: event.toolCallId,
      turnId,
      stepId: step.stepId,
      name: event.name ?? '',
      state: 'running',
      inputText: event.argumentsPart ?? '',
      agentRefs: [],
      startedAt: epochMsToIso(event.time),
    };
    this.tools.set(event.toolCallId, tool);
    ops.push(this.toolOp(tool));
    if ((event.argumentsPart ?? '').length > 0) {
      ops.push(this.toolDeltaOp(event.toolCallId, event.argumentsPart ?? ''));
    }
    return ops;
  }

  private onToolProgress(event: {
    toolCallId: string;
    update: {
      kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
      text?: string;
      percent?: number;
      customKind?: string;
      customData?: unknown;
    };
  }): ServerMessage[] {
    const tool = this.tools.get(event.toolCallId);
    if (tool === undefined) return [];
    tool.progress = {
      kind: event.update.kind,
      text: event.update.text,
      percent: event.update.percent,
      custom_kind: event.update.customKind,
      custom_data: event.update.customData,
    };
    return [
      {
        type: 'tool.progress',
        ...this.base(),
        tool_call_id: event.toolCallId,
        progress: tool.progress,
      },
    ];
  }

  private onToolCallStarted(event: {
    time: number;
    turnId: number;
    toolCallId: string;
    name: string;
    args: unknown;
    display?: unknown;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const turnId = turnIdOf(event.turnId);
    this.ensureTurn(turnId, event.time, ops);
    const step = this.ensureStep(turnId, event.time, ops);
    const prev = this.tools.get(event.toolCallId);
    const input = parseToolArgs(event.args);
    const todoItems = event.name === 'TodoList' ? todoWriteItems(input) : undefined;
    const tool: ToolRecord = {
      toolCallId: event.toolCallId,
      turnId,
      stepId: step.stepId,
      name: event.name,
      state: 'running',
      input,
      inputText: prev?.inputText ?? (typeof event.args === 'string' ? event.args : undefined),
      display: event.display,
      todoId: todoItems !== undefined ? TODO_ENTITY_ID : undefined,
      progress: prev?.progress,
      agentRefs: prev?.agentRefs ?? [],
      startedAt: prev?.startedAt ?? epochMsToIso(event.time),
    };
    this.tools.set(event.toolCallId, tool);
    ops.push(this.toolOp(tool));
    return ops;
  }

  private onToolResult(event: {
    time: number;
    turnId: number;
    toolCallId: string;
    output: unknown;
    isError?: boolean;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    let tool = this.tools.get(event.toolCallId);
    if (tool === undefined) {
      const turnId = turnIdOf(event.turnId);
      this.ensureTurn(turnId, event.time, ops);
      const step = this.ensureStep(turnId, event.time, ops);
      tool = {
        toolCallId: event.toolCallId,
        turnId,
        stepId: step.stepId,
        name: '',
        state: 'running',
        agentRefs: [],
      };
      this.tools.set(event.toolCallId, tool);
    }
    const isError = event.isError === true;
    tool.state = isError ? 'error' : 'done';
    tool.output = event.output;
    tool.error = isError && typeof event.output === 'string' ? event.output : undefined;
    ops.push(this.toolOp(tool));
    return ops;
  }

  private onTaskLifecycle(event: {
    type: 'task.started' | 'task.terminated';
    time: number;
    info: AgentTaskInfo;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const { info } = event;
    const agentInfo = agentInfoOf(info);
    const parentTool =
      agentInfo?.parentToolCallId === undefined
        ? undefined
        : this.tools.get(agentInfo.parentToolCallId);
    const task = this.upsertTask(info.taskId, (prev) => ({
      taskId: info.taskId,
      kind: mapTaskKind(info.kind),
      state: info.status,
      detached: info.detached ?? prev?.detached ?? true,
      description: info.description,
      childAgentId: agentInfo?.agentId ?? prev?.childAgentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? parentTool?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: info.endedAt === null ? prev?.endedAt : epochMsToIso(info.endedAt),
      resultSummary: prev?.resultSummary,
      usage: prev?.usage,
      error: prev?.error,
      stateReason: info.stopReason ?? prev?.stateReason,
      model: agentInfo?.model ?? prev?.model,
      thinkingEffort: agentInfo?.thinkingEffort ?? prev?.thinkingEffort,
    }));
    if (event.type === 'task.started') {
      const childAgentId = agentInfo?.agentId;
      if (info.kind === 'agent' && typeof childAgentId === 'string' && childAgentId.length > 0) {
        this.subagentTaskIds.set(childAgentId, info.taskId);
        if (parentTool !== undefined && parentTool.taskId !== info.taskId) {
          parentTool.taskId = info.taskId;
          ops.push(this.toolOp(parentTool));
        }
      }
    }
    ops.push(this.taskOp(task));
    return ops;
  }

  private onShellStarted(event: {
    time: number;
    commandId: string;
    taskId: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    this.shellTasks.set(event.commandId, event.taskId);
    const task = this.upsertTask(event.taskId, (prev) => ({
      taskId: event.taskId,
      kind: 'shell',
      state: 'running',
      detached: prev?.detached ?? false,
      description: prev?.description,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(event.time),
    }));
    ops.push(this.taskOp(task));
    return ops;
  }

  private shellTaskId(event: { commandId: string; taskId?: string }): string {
    const taskId =
      this.shellTasks.get(event.commandId) ?? event.taskId ?? `shell-${event.commandId}`;
    this.shellTasks.set(event.commandId, taskId);
    return taskId;
  }

  private onShellOutput(event: {
    time: number;
    commandId: string;
    taskId?: string;
    update: { kind: string; text?: string };
  }): ServerMessage[] {
    const text = event.update.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const ops = this.settlePendingClear();
    const taskId = this.shellTaskId(event);
    const task = this.upsertTask(taskId, (prev) => ({
      taskId,
      kind: prev?.kind ?? 'shell',
      state: 'running',
      detached: prev?.detached ?? false,
      description: prev?.description,
      outputTail: tailWindow((prev?.outputTail ?? '') + text),
      startedAt: prev?.startedAt ?? epochMsToIso(event.time),
    }));
    ops.push(this.taskOp(task));
    return ops;
  }

  private onShellCompleted(event: {
    time: number;
    commandId: string;
    taskId?: string;
    isError: boolean;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const taskId = this.shellTaskId(event);
    const task = this.upsertTask(taskId, (prev) => ({
      taskId,
      kind: prev?.kind ?? 'shell',
      state: event.isError ? 'failed' : 'completed',
      detached: prev?.detached ?? false,
      description: prev?.description,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? epochMsToIso(event.time),
      endedAt: epochMsToIso(event.time),
    }));
    ops.push(this.taskOp(task));
    return ops;
  }

  private upsertTask(
    taskId: string,
    build: (prev: TaskRecord | undefined) => TaskRecord,
  ): TaskRecord {
    const task = build(this.tasks.get(taskId));
    this.tasks.set(taskId, task);
    return task;
  }

  private onSubagentSpawned(event: {
    time: number;
    subagentId: string;
    parentToolCallId: string;
    description?: string;
    swarmIndex?: number;
    runInBackground: boolean;
    taskId?: string;
    model?: string;
    thinkingEffort?: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const tool = this.tools.get(event.parentToolCallId);
    if (tool !== undefined) {
      const ref: ToolCallAgentRef = {
        agent_id: event.subagentId,
        role: event.swarmIndex !== undefined ? 'member' : 'child',
      };
      tool.agentRefs = [...tool.agentRefs, ref];
      ops.push(this.toolOp(tool));
    }
    const taskId = event.taskId;
    if (taskId === undefined) return ops;
    this.subagentTaskIds.set(event.subagentId, taskId);
    if (tool !== undefined && tool.taskId !== taskId) {
      tool.taskId = taskId;
      ops.push(this.toolOp(tool));
    }
    const task = this.upsertTask(taskId, (prev) => ({
      taskId,
      kind: 'subagent',
      state: 'running',
      detached: event.runInBackground,
      description: event.description ?? prev?.description,
      childAgentId: event.subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? tool?.startedAt ?? epochMsToIso(event.time),
      model: event.model ?? prev?.model,
      thinkingEffort: event.thinkingEffort ?? prev?.thinkingEffort,
    }));
    ops.push(this.taskOp(task));
    return ops;
  }

  private onSubagentRun(event: {
    type: 'subagent.completed' | 'subagent.failed' | 'subagent.suspended';
    time: number;
    subagentId: string;
    resultSummary?: string;
    usage?: TokenUsage;
    error?: string;
    reason?: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const taskKey = this.subagentTaskIds.get(event.subagentId) ?? event.subagentId;
    const existing = this.tasks.get(taskKey);
    if (existing === undefined) return ops;
    const terminal = event.type !== 'subagent.suspended';
    existing.state =
      event.type === 'subagent.completed'
        ? 'completed'
        : event.type === 'subagent.failed'
          ? 'failed'
          : 'running';
    if (terminal) existing.endedAt = epochMsToIso(event.time);
    existing.resultSummary = event.resultSummary ?? existing.resultSummary;
    existing.usage = event.usage === undefined ? existing.usage : toSnakeUsage(event.usage);
    existing.error = event.error ?? existing.error;
    existing.stateReason = event.reason ?? existing.stateReason;
    ops.push(this.taskOp(existing));
    return ops;
  }

  private onGoalUpdated(event: {
    time: number;
    snapshot: {
      objective: string;
      status: 'active' | 'paused' | 'blocked' | 'complete';
      completionCriterion?: string;
      tokensUsed: number;
      budget: { tokenBudget: number | null };
    } | null;
  }): ServerMessage[] {
    const snapshot = event.snapshot;
    const payload =
      snapshot === null
        ? undefined
        : {
            objective: snapshot.objective,
            status: snapshot.status,
            completion_criterion: snapshot.completionCriterion,
            budget_used: snapshot.tokensUsed,
            budget_limit: snapshot.budget.tokenBudget ?? undefined,
          };
    return [this.systemOp('goal', payload, event.time)];
  }

  private onAgentStatusUpdated(event: {
    time: number;
    planMode?: boolean;
    swarmMode?: boolean;
  }): ServerMessage[] {
    const ops: ServerMessage[] = [];
    if (event.planMode !== undefined && event.planMode !== this.planMode) {
      this.planMode = event.planMode;
      if (event.planMode) {
        ops.push(this.systemOp('plan.enter', undefined, event.time));
      } else if (this.planExitApproved()) {
        ops.push(this.systemOp('plan.exit', undefined, event.time));
      }
    }
    if (event.swarmMode !== undefined && event.swarmMode !== this.swarmMode) {
      this.swarmMode = event.swarmMode;
      ops.push(
        this.systemOp(event.swarmMode ? 'swarm.enter' : 'swarm.exit', undefined, event.time),
      );
    }
    return ops;
  }

  private planExitApproved(): boolean {
    let latest: ToolRecord | undefined;
    for (const tool of this.tools.values()) {
      if (tool.name === 'ExitPlanMode') latest = tool;
    }
    if (latest?.approvalId === undefined) return false;
    return this.interactions.get(latest.approvalId)?.state === 'approved';
  }

  private onPlanRevision(event: {
    time: number;
    id: string;
    version: number;
    key: string;
    sha256: string;
    bytes: number;
  }): ServerMessage[] {
    const path = this.lookups?.resolvePlanRevisionKey?.(event.key) ?? event.key;
    return [
      this.systemOp(
        'plan.revision',
        { id: event.id, version: event.version, path, sha256: event.sha256, bytes: event.bytes },
        event.time,
      ),
    ];
  }

  private onPromptSubmitted(event: {
    promptId: string;
    userMessageId: string;
    status: 'running' | 'queued';
    content: readonly ContentPart[];
    createdAt: string;
  }): ServerMessage[] {
    const prev = this.prompts.get(event.promptId);
    this.prompts.set(event.promptId, {
      promptId: event.promptId,
      text: promptTextOf(event.content),
      status: event.status,
      createdAt: prev?.createdAt ?? event.createdAt,
      turnId: prev?.turnId,
      messageId: prev?.messageId,
    });
    return [];
  }

  private onPromptQueued(event: {
    promptId: string;
    content: readonly ContentPart[];
  }): ServerMessage[] {
    let prev = this.prompts.get(event.promptId);
    if (prev === undefined) {
      prev = {
        promptId: event.promptId,
        text: promptTextOf(event.content),
        status: 'queued',
        createdAt: nowIso(),
      };
      this.prompts.set(event.promptId, prev);
    }
    if (prev.messageId !== undefined) return [];
    return [this.predictReservedUser(prev)];
  }

  private onPromptStarted(event: { promptId: string }): ServerMessage[] {
    const prev = this.prompts.get(event.promptId);
    if (prev === undefined) return [];
    prev.status = 'running';
    if (prev.turnId !== undefined) return [];
    return [this.predictReservedUser(prev)];
  }

  private predictReservedUser(prompt: PromptRecord): ServerMessage {
    const ordinal = Math.max(this.nextTurnIdHint, this.queuedTurnIdCursor ?? 0);
    this.queuedTurnIdCursor = ordinal + 1;
    const turnId = turnIdOf(ordinal);
    const messageId = turnUserMessageIdOf(turnId);
    prompt.turnId = turnId;
    prompt.messageId = messageId;
    prompt.predicted = true;
    const user: UserRecord = {
      messageId,
      turnId,
      promptId: prompt.promptId,
      text: prompt.text,
      status: 'running',
      createdAt: prompt.createdAt,
    };
    this.users.set(messageId, user);
    return this.userOp(user);
  }

  private releasePredictedTurnId(prompt: PromptRecord): void {
    if (prompt.predicted !== true || prompt.turnId === undefined) return;
    prompt.predicted = false;
    const ordinal = turnOrdinalOf(prompt.turnId);
    if (ordinal !== undefined && this.queuedTurnIdCursor === ordinal + 1) {
      this.queuedTurnIdCursor = ordinal;
    }
  }

  private onPromptCompleted(event: { promptId: string; finishedAt: string }): ServerMessage[] {
    const prev = this.prompts.get(event.promptId);
    if (prev === undefined) return [];
    prev.status = 'completed';
    this.releasePredictedTurnId(prev);
    return this.completeUserByPrompt(prev, event.finishedAt);
  }

  private onPromptAborted(event: { promptId: string; abortedAt: string }): ServerMessage[] {
    const prev = this.prompts.get(event.promptId);
    if (prev === undefined) return [];
    prev.status = 'aborted';
    this.releasePredictedTurnId(prev);
    return this.completeUserByPrompt(prev, event.abortedAt);
  }

  private completeUserByPrompt(prompt: PromptRecord, at: string): ServerMessage[] {
    if (prompt.messageId === undefined) return [];
    const user = this.users.get(prompt.messageId);
    if (user === undefined || user.status !== 'running') return [];
    user.status = 'completed';
    user.finishedAt = at;
    return [this.userOp(user)];
  }

  private onPromptSteered(event: {
    activePromptId: string;
    promptIds: string[];
    content: readonly ContentPart[];
    steeredAt: string;
  }): ServerMessage[] {
    const active = this.prompts.get(event.activePromptId);
    if (active !== undefined) active.text = promptTextOf(event.content);
    const ops: ServerMessage[] = [];
    for (const promptId of event.promptIds) {
      const prev = this.prompts.get(promptId);
      if (prev === undefined) continue;
      prev.status = 'completed';
      this.releasePredictedTurnId(prev);
      ops.push(...this.completeUserByPrompt(prev, event.steeredAt));
    }
    return ops;
  }

  private onTurnSteered(event: {
    time: number;
    input: readonly ContentPart[];
    origin: unknown;
  }): ServerMessage[] {
    const origin = event.origin as {
      kind?: string;
      skillActivations?: readonly { skillName: string; skillArgs?: string }[];
      jobId?: string;
      cron?: string;
      trigger?: string;
    };
    const kind = origin.kind;
    if (kind !== 'user' && kind !== 'skill_activation' && kind !== 'cron_job') return [];
    if (kind === 'skill_activation' && origin.trigger !== 'user-slash') return [];
    const ops = this.settlePendingClear();
    const turn = this.currentTurn;
    if (turn === undefined || turn.state !== 'running') return ops;
    const steer: PendingSteer = {
      input: event.input,
      origin: userOriginOf(event.origin),
      skillActivations: skillActivationsOf(event.origin),
      skipBlocks: kind === 'user' ? (origin.skillActivations?.length ?? 0) : 0,
      at: epochMsToIso(event.time),
    };
    const step = this.currentStep;
    const stepStarted = step !== undefined && step.turnId === turn.turnId;
    if (!stepStarted && !turn.openingSteerDeduped && turn.openingKey !== undefined) {
      const key = this.steerKey(steer);
      if (key.text === turn.openingKey.text && key.attachments === turn.openingKey.attachments) {
        turn.openingSteerDeduped = true;
        return ops;
      }
    }
    if (step !== undefined && step.state === 'running' && step.turnId === turn.turnId) {
      ops.push(this.steerUserMessage(step, steer));
      return ops;
    }
    this.pendingSteers.push(steer);
    return ops;
  }

  private steerKey(steer: PendingSteer): { text: string; attachments: number } {
    let text = '';
    let attachments = 0;
    for (const part of steer.input.slice(steer.skipBlocks)) {
      if (part.type === 'text') {
        text += part.text;
        continue;
      }
      if (daemonFileRefFromPart(part) !== undefined) attachments += 1;
    }
    return { text, attachments };
  }

  private steerUserMessage(step: StepRecord, steer: PendingSteer): ServerMessage {
    this.userSeq += 1;
    const messageId = stepUserMessageIdOf(step.stepId, this.userSeq);
    const texts: string[] = [];
    const attachmentIds: string[] = [];
    for (const part of steer.input.slice(steer.skipBlocks)) {
      if (part.type === 'text') {
        texts.push(part.text);
        continue;
      }
      if (daemonFileRefFromPart(part) === undefined) continue;
      this.attachmentSeq += 1;
      attachmentIds.push(attachmentIdOf(step.stepId, this.attachmentSeq));
    }
    const user: UserRecord = {
      messageId,
      turnId: step.turnId,
      stepId: step.stepId,
      text: steer.notification?.text ?? texts.join(''),
      status: 'running',
      createdAt: steer.at,
      steeredAt: steer.at,
      origin: steer.origin,
      notification: steer.notification?.payload,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      skillActivations: steer.skillActivations,
    };
    this.users.set(messageId, user);
    return this.userOp(user);
  }

  private onTaskNotified(event: {
    time: number;
    notificationType: string;
    title: string;
    body: string;
    severity: string;
    sourceKind: string;
    sourceId: string;
  }): ServerMessage[] {
    const ops = this.settlePendingClear();
    const origin = taskUserOriginOf(event.sourceId);
    if (origin === undefined) return ops;
    const notification: TaskNotificationPayload = {
      title: event.title,
      body: event.body,
      severity: event.severity,
      type: event.notificationType,
      source_kind: event.sourceKind,
      source_id: event.sourceId,
    };
    const text = notificationTextOf(notification);
    const at = epochMsToIso(event.time);
    const turn = this.currentTurn;
    if (
      turn !== undefined &&
      turn.state === 'running' &&
      turn.origin.kind === 'task' &&
      turn.origin.task_id === origin.task_id
    ) {
      const messageId = turn.userMessageId ?? turnUserMessageIdOf(turn.turnId);
      if (turn.userMessageId === undefined) {
        turn.userMessageId = messageId;
        ops.push(this.turnOp(turn));
      }
      const existing = this.users.get(messageId);
      if (existing !== undefined) {
        if (existing.notification === undefined) {
          existing.text = text;
          existing.origin = origin;
          existing.notification = notification;
          ops.push(this.userOp(existing));
        }
        return ops;
      }
      const user: UserRecord = {
        messageId,
        turnId: turn.turnId,
        text,
        status: 'running',
        createdAt: at,
        origin,
        notification,
      };
      this.users.set(messageId, user);
      ops.push(this.userOp(user));
      return ops;
    }
    if (turn !== undefined && turn.state === 'running') {
      const steer: PendingSteer = {
        input: [],
        origin,
        skillActivations: undefined,
        skipBlocks: 0,
        at,
        notification: { payload: notification, text },
      };
      const step = this.currentStep;
      if (step !== undefined && step.state === 'running' && step.turnId === turn.turnId) {
        ops.push(this.steerUserMessage(step, steer));
        return ops;
      }
      this.pendingSteers.push(steer);
      return ops;
    }
    this.phantomUserSeq += 1;
    const turnId = turnIdOf(this.nextTurnIdHint);
    const user: UserRecord = {
      messageId: `${turnId}.u${this.phantomUserSeq}`,
      turnId,
      text,
      status: 'completed',
      createdAt: at,
      origin,
      notification,
    };
    this.users.set(user.messageId, user);
    ops.push(this.userOp(user));
    return ops;
  }

  private onContextSpliced(event: {
    start: number;
    deleteCount: number;
    messages: readonly unknown[];
  }): ServerMessage[] {
    if (event.start === 0 && event.deleteCount > 0 && event.messages.length === 0) {
      this.pendingFullCut = true;
      this.armPendingClearTimer();
    }
    return [];
  }

  private armPendingClearTimer(): void {
    if (this.pendingClearTimer !== undefined) return;
    this.pendingClearTimer = setTimeout(() => {
      this.pendingClearTimer = undefined;
      if (!this.pendingFullCut) return;
      this.pendingFullCut = false;
      this.hooks?.onDeferred?.(this.applyClear());
    }, PENDING_CLEAR_SETTLE_MS);
    this.pendingClearTimer.unref();
  }

  private cancelPendingClearTimer(): void {
    if (this.pendingClearTimer === undefined) return;
    clearTimeout(this.pendingClearTimer);
    this.pendingClearTimer = undefined;
  }

  private settlePendingClear(): ServerMessage[] {
    if (!this.pendingFullCut) return [];
    this.cancelPendingClearTimer();
    this.pendingFullCut = false;
    return this.applyClear();
  }

  private applyClear(): ServerMessage[] {
    this.timelineRewriteCount += 1;
    const removed = [...this.timelineIds];
    const op = this.systemOp('clear', { removed_ids: removed }, undefined);
    this.turns.clear();
    this.steps.clear();
    this.texts.clear();
    this.stepTextIds.clear();
    this.stepTextSeqs.clear();
    this.tools.clear();
    this.users.clear();
    this.stepOrdinals.clear();
    this.stepUsageByTurn.clear();
    this.timelineIds.length = 0;
    this.currentTurn = undefined;
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    this.pendingSteers = [];
    return [op];
  }

  private onContextUndone(event: {
    time: number;
    turns: number;
    fromTurnId?: number;
  }): ServerMessage[] {
    this.cancelPendingClearTimer();
    this.pendingFullCut = false;
    const removed = this.removedIdsForUndo(event.turns, event.fromTurnId);
    if (removed.length === 0) return [];
    this.timelineRewriteCount += 1;
    const op = this.systemOp('undo', { removed_ids: removed }, event.time);
    for (const id of removed) {
      if (turnOrdinalOf(id) === undefined) continue;
      this.dropTurnDetails(id);
      this.stepOrdinals.delete(id);
      this.stepUsageByTurn.delete(id);
    }
    const firstRemoved = this.timelineIds.indexOf(removed[0]!);
    if (firstRemoved >= 0) this.timelineIds.splice(firstRemoved);
    return [op];
  }

  private removedIdsForUndo(turns: number, fromTurnId: number | undefined): string[] {
    const cut = this.findUndoCutIndex(turns, fromTurnId);
    if (cut === undefined) return [];
    return this.timelineIds.slice(cut);
  }

  private findUndoCutIndex(turns: number, fromTurnId: number | undefined): number | undefined {
    if (fromTurnId !== undefined) {
      for (let i = 0; i < this.timelineIds.length; i++) {
        const ordinal = turnOrdinalOf(this.timelineIds[i]!);
        if (ordinal !== undefined && ordinal >= fromTurnId) return i;
      }
      return undefined;
    }
    let remaining = turns;
    for (let i = this.timelineIds.length - 1; i >= 0; i--) {
      const id = this.timelineIds[i]!;
      if (isCompactionSystemId(id)) return undefined;
      const ordinal = turnOrdinalOf(id);
      if (ordinal === undefined) continue;
      if (!this.anchorTurnOrdinals.has(ordinal)) continue;
      remaining -= 1;
      if (remaining === 0) return i;
    }
    return undefined;
  }

  private dropTurnDetails(turnId: string): void {
    this.turns.delete(turnId);
    for (const [stepId, step] of this.steps) {
      if (step.turnId === turnId) this.steps.delete(stepId);
    }
    for (const [stepId, entry] of this.stepTextIds) {
      if (!stepId.startsWith(`${turnId}.`)) continue;
      if (entry.assistant !== undefined) this.texts.delete(entry.assistant);
      if (entry.thinking !== undefined) this.texts.delete(entry.thinking);
      this.stepTextIds.delete(stepId);
      this.stepTextSeqs.delete(stepId);
    }
    for (const [toolCallId, tool] of this.tools) {
      if (tool.turnId === turnId) this.tools.delete(toolCallId);
    }
    for (const [messageId, user] of this.users) {
      if (user.turnId === turnId) this.users.delete(messageId);
    }
  }

  private mapTurnOrigin(origin: unknown): TurnOrigin {
    return toTurnOrigin(origin, this.agentId, this.subagentTaskIds);
  }

  private wireInteractionRequest(interaction: ProjectorInteraction): unknown {
    return wireInteractionRequest(interaction.kind, interaction.payload);
  }

  private wireInteractionResponse(record: InteractionRecord, response: unknown): unknown {
    return wireInteractionResponse(record.kind, record.request, response);
  }

  private createTextRecord(
    stepId: string,
    turnId: string,
    kind: 'assistant' | 'thinking',
  ): TextRecord {
    const seq = (this.stepTextSeqs.get(stepId) ?? 0) + 1;
    this.stepTextSeqs.set(stepId, seq);
    const record: TextRecord = {
      messageId: textMessageIdOf(stepId, seq),
      kind,
      turnId,
      stepId,
      status: 'streaming',
      text: '',
    };
    this.texts.set(record.messageId, record);
    const entry = this.stepTextIds.get(stepId) ?? {};
    entry[kind] = record.messageId;
    this.stepTextIds.set(stepId, entry);
    return record;
  }

  private base(): { session_id: string; agent_id: string; timestamp: string } {
    return { session_id: this.sessionId, agent_id: this.agentId, timestamp: nowIso() };
  }

  private turnOp(turn: TurnRecord): TurnMessage {
    return {
      type: 'turn',
      ...this.base(),
      turn_id: turn.turnId,
      ordinal: turn.ordinal,
      state: turn.state,
      origin: turn.origin,
      user_message_id: turn.userMessageId,
      attachment_ids: turn.attachmentIds,
      started_at: turn.startedAt,
      ended_at: turn.endedAt,
      usage: turn.usage === undefined ? undefined : turnUsageToWire(turn.usage),
      duration_ms: turn.durationMs,
    };
  }

  private stepOp(step: StepRecord): StepMessage {
    return {
      type: 'step',
      ...this.base(),
      step_id: step.stepId,
      turn_id: step.turnId,
      ordinal: step.ordinal,
      state: step.state,
      started_at: step.startedAt,
      ended_at: step.endedAt,
      usage: step.usage,
      finish_reason: step.finishReason,
      timing: step.timing,
      retry: step.retry,
      end_reason: step.endReason,
      end_message: step.endMessage,
    };
  }

  private textOp(record: TextRecord): AssistantMessage | ThinkingMessage {
    const base = {
      ...this.base(),
      message_id: record.messageId,
      turn_id: record.turnId,
      step_id: record.stepId,
      status: record.status,
      text: record.text,
    };
    if (record.kind === 'assistant') return { type: 'assistant', ...base };
    return { type: 'thinking', ...base };
  }

  private textDeltaOp(record: TextRecord, delta: string): ServerMessage {
    if (record.kind === 'assistant') {
      return {
        type: 'assistant.delta',
        ...this.base(),
        message_id: record.messageId,
        text: delta,
      };
    }
    return {
      type: 'thinking.delta',
      ...this.base(),
      message_id: record.messageId,
      text: delta,
    };
  }

  private toolOp(tool: ToolRecord): ToolCallMessage {
    return {
      type: 'tool_call',
      ...this.base(),
      tool_call_id: tool.toolCallId,
      turn_id: tool.turnId,
      step_id: tool.stepId,
      name: tool.name,
      state: tool.state,
      input: tool.input,
      input_text: tool.inputText,
      output: tool.output,
      display: tool.display,
      error: tool.error,
      progress: tool.progress,
      task_id: tool.taskId,
      approval_id: tool.approvalId,
      todo_id: tool.todoId,
      agent_refs: tool.agentRefs.length > 0 ? tool.agentRefs : undefined,
    };
  }

  private toolDeltaOp(toolCallId: string, inputText: string): ServerMessage {
    return {
      type: 'tool_call.delta',
      ...this.base(),
      tool_call_id: toolCallId,
      input_text: inputText,
    };
  }

  private userOp(user: UserRecord): UserMessage {
    return {
      type: 'user',
      ...this.base(),
      message_id: user.messageId,
      turn_id: user.turnId,
      step_id: user.stepId,
      text: user.text,
      attachment_ids: user.attachmentIds,
      skill_activations: user.skillActivations,
      status: user.status,
      created_at: user.createdAt,
      finished_at: user.finishedAt,
      steered_at: user.steeredAt,
      origin: user.origin,
      notification: user.notification,
    };
  }

  private taskOp(task: TaskRecord): TaskMessage {
    return {
      type: 'task',
      ...this.base(),
      task_id: task.taskId,
      kind: task.kind,
      state: task.state,
      detached: task.detached,
      description: task.description,
      child_agent_id: task.childAgentId,
      output_tail: task.outputTail,
      started_at: task.startedAt,
      ended_at: task.endedAt,
      result_summary: task.resultSummary,
      error: task.error,
      state_reason: task.stateReason,
      usage: task.usage,
      model: task.model,
      thinking_effort: task.thinkingEffort,
    };
  }

  private interactionOp(record: InteractionRecord): InteractionMessage {
    return {
      type: 'interaction',
      ...this.base(),
      interaction_id: record.interactionId,
      kind: record.kind,
      state: record.state,
      tool_call_id: record.toolCallId,
      request: record.request,
      response: record.response,
    } as InteractionMessage;
  }

  private todoOp(): TodoMessage {
    return {
      type: 'todo',
      ...this.base(),
      todo_id: TODO_ENTITY_ID,
      items: this.todoItems ?? [],
      updated_at: this.todoUpdatedAt,
    };
  }

  private systemOp(
    subtype: SystemMessage['subtype'],
    payload: unknown,
    time?: number,
  ): SystemMessage {
    const systemId = this.sysIds.next(subtype);
    this.timelineIds.push(systemId);
    return {
      type: 'system',
      ...this.base(),
      system_id: systemId,
      subtype,
      payload,
      at: time === undefined ? undefined : epochMsToIso(time),
    } as SystemMessage;
  }
}

export function toTurnOrigin(
  origin: unknown,
  agentId: string,
  subagentTaskIds: ReadonlyMap<string, string>,
): TurnOrigin {
  const candidate = origin as
    | { kind?: unknown; taskId?: unknown; name?: unknown }
    | null
    | undefined;
  const kind = typeof candidate?.kind === 'string' ? candidate.kind : undefined;
  if (kind === undefined) return { kind: 'other' };
  switch (kind) {
    case 'user':
    case 'skill_activation':
    case 'plugin_command':
    case 'shell_command':
      return { kind: 'user' };
    case 'cron_job':
    case 'cron_missed':
      return { kind: 'cron' };
    case 'task':
    case 'background_task': {
      const taskId = candidate?.taskId;
      return typeof taskId === 'string' ? { kind: 'task', task_id: taskId } : { kind: 'other' };
    }
    case 'hook_result':
      return { kind: 'hook' };
    case 'compaction_summary':
      return { kind: 'compaction' };
    case 'system_trigger': {
      if (candidate?.name === 'goal_continuation') return { kind: 'goal' };
      const taskId = subagentTaskIds.get(agentId);
      return taskId === undefined ? { kind: 'other' } : { kind: 'task', task_id: taskId };
    }
    default:
      return { kind: 'other' };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

function restOf(event: {
  readonly type: string;
  readonly time?: number;
  readonly agentId?: string;
}): Record<string, unknown> {
  const { type: _type, time: _time, agentId: _agentId, ...rest } = event;
  return rest;
}

function toSnakeUsage(usage: TokenUsage): StepUsage {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function turnUsageToWire(usage: StepUsage): {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
} {
  return {
    input_tokens: usage.input_other + usage.input_cache_creation,
    output_tokens: usage.output,
    cached_tokens: usage.input_cache_read,
  };
}

function timingOf(event: {
  llmFirstTokenLatencyMs?: number;
  llmStreamDurationMs?: number;
}): StepTiming | undefined {
  if (event.llmFirstTokenLatencyMs === undefined && event.llmStreamDurationMs === undefined) {
    return undefined;
  }
  return {
    llm_first_token_ms: event.llmFirstTokenLatencyMs,
    llm_stream_duration_ms: event.llmStreamDurationMs,
  };
}

function mapTaskKind(kind: string): TaskMessage['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

function agentInfoOf(info: AgentTaskInfo):
  | {
      agentId?: string;
      parentToolCallId?: string;
      model?: string;
      thinkingEffort?: string;
    }
  | undefined {
  if (info.kind !== 'agent') return undefined;
  return info as {
    agentId?: string;
    parentToolCallId?: string;
    model?: string;
    thinkingEffort?: string;
  };
}

function tailWindow(text: string): string {
  return text.length <= TASK_OUTPUT_TAIL_MAX ? text : text.slice(text.length - TASK_OUTPUT_TAIL_MAX);
}

export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string' || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

export function todoWriteItems(input: unknown): readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items = readTodoItems(todos);
  return items.length === 0 && todos.length > 0 ? undefined : items;
}

export function mapInteractionEndState(
  kind: 'approval' | 'question',
  response: unknown,
): InteractionMessage['state'] {
  if (isCancellation(response)) return 'cancelled';
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}

export function isCancellation(response: unknown): boolean {
  return (response as { cancelled?: unknown } | null | undefined)?.cancelled === true;
}

export function wantsUserMessage(origin: unknown, promptText: string | undefined): boolean {
  const candidate = origin as { kind?: unknown; name?: unknown } | null | undefined;
  switch (candidate?.kind) {
    case 'user':
    case 'skill_activation':
    case 'plugin_command':
    case 'shell_command':
    case 'cron_job':
    case 'cron_missed':
      return true;
    case 'system_trigger':
      return (
        candidate.name === 'subagent' &&
        typeof promptText === 'string' &&
        promptText.length > 0
      );
    default:
      return false;
  }
}

export function userOriginOf(origin: unknown): UserMessageOrigin | undefined {
  const candidate = origin as
    | { kind?: unknown; jobId?: unknown; cron?: unknown; skillName?: unknown; skillArgs?: unknown; trigger?: unknown }
    | null
    | undefined;
  if (candidate?.kind === 'cron_job') return cronUserOrigin(candidate);
  if (candidate?.kind === 'cron_missed') return { kind: 'cron' };
  if (candidate?.kind === 'skill_activation' && typeof candidate.skillName === 'string') {
    return {
      kind: 'skill',
      skill_name: candidate.skillName,
      args: typeof candidate.skillArgs === 'string' ? candidate.skillArgs : undefined,
      trigger: typeof candidate.trigger === 'string' ? candidate.trigger : undefined,
    };
  }
  return undefined;
}

export function taskUserOriginOf(taskId: unknown): Extract<UserMessageOrigin, { kind: 'task' }> | undefined {
  if (typeof taskId !== 'string' || taskId.length === 0) return undefined;
  return { kind: 'task', task_id: taskId };
}

export function taskNotificationOriginOf(
  origin: unknown,
): Extract<UserMessageOrigin, { kind: 'task' }> | undefined {
  const candidate = origin as { kind?: unknown; taskId?: unknown } | null | undefined;
  if (candidate?.kind !== 'task' && candidate?.kind !== 'background_task') return undefined;
  return taskUserOriginOf(candidate.taskId);
}

export function notificationTextOf(notification: {
  title: string;
  body: string;
}): string {
  return `${notification.title}\n${notification.body}`.trim();
}

function cronUserOrigin(candidate: {
  jobId?: unknown;
  cron?: unknown;
}): UserMessageOrigin | undefined {
  if (typeof candidate.jobId !== 'string' || typeof candidate.cron !== 'string') return undefined;
  return { kind: 'cron', cron_id: candidate.jobId, schedule: candidate.cron };
}

export function skillActivationsOf(
  origin: unknown,
): { skill_name: string; skill_args?: string }[] | undefined {
  const candidate = origin as {
    kind?: unknown;
    skillActivations?: readonly { skillName: string; skillArgs?: string }[];
    skillName?: unknown;
    skillArgs?: unknown;
  } | null | undefined;
  if (candidate?.kind === 'user') {
    const activations = candidate.skillActivations ?? [];
    if (activations.length === 0) return undefined;
    return activations.map((a) => ({ skill_name: a.skillName, skill_args: a.skillArgs }));
  }
  if (candidate?.kind === 'skill_activation' && typeof candidate.skillName === 'string') {
    return [
      {
        skill_name: candidate.skillName,
        skill_args: typeof candidate.skillArgs === 'string' ? candidate.skillArgs : undefined,
      },
    ];
  }
  return undefined;
}

export function promptTextOf(content: readonly ContentPart[]): string {
  return content
    .filter((part): part is ContentPart & { type: 'text' } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function hookPayload(event: {
  turnId?: number;
  hookEvent: string;
  content: string;
  blocked?: boolean;
}): Record<string, unknown> {
  return {
    turn_id: event.turnId,
    hook_event: event.hookEvent,
    content: event.content,
    blocked: event.blocked,
  };
}

function skillPayload(event: {
  readonly activationId?: string;
  readonly skillName?: string;
  readonly skillArgs?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
  readonly trigger?: string;
  readonly pluginId?: string;
  readonly commandName?: string;
  readonly commandArgs?: string;
}): Record<string, unknown> {
  return {
    trigger: event.trigger,
    plugin_id: event.pluginId,
    command_name: event.commandName,
    command_args: event.commandArgs,
    activation_id: event.activationId,
    skill_name: event.skillName,
    skill_args: event.skillArgs,
    skill_path: event.skillPath,
    skill_source: event.skillSource,
  };
}

export function wireInteractionRequest(kind: 'approval' | 'question', payload: unknown): unknown {
  if (kind === 'approval') {
    const record = payload as Record<string, unknown> | null;
    const toolName = typeof record?.['toolName'] === 'string' ? record['toolName'] : undefined;
    if (toolName === undefined || toolName.length === 0) return undefined;
    return {
      tool_name: toolName,
      action: typeof record?.['action'] === 'string' ? record['action'] : '',
      tool_input_display: record?.['display'],
    };
  }
  return toV3QuestionRequest(payload);
}

export function wireInteractionResponse(
  kind: 'approval' | 'question',
  request: unknown,
  response: unknown,
): unknown {
  if (isCancellation(response)) {
    return kind === 'approval' ? { decision: 'cancelled' } : undefined;
  }
  if (kind === 'approval') {
    const r = response as {
      decision?: unknown;
      scope?: unknown;
      feedback?: unknown;
      selectedLabel?: unknown;
    } | null;
    if (r === null || typeof r !== 'object') return undefined;
    const decision = r.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'cancelled') {
      return undefined;
    }
    return {
      decision,
      scope: r.scope === 'session' ? 'session' : undefined,
      feedback: typeof r.feedback === 'string' ? r.feedback : undefined,
      selected_label: typeof r.selectedLabel === 'string' ? r.selectedLabel : undefined,
    };
  }
  return mapQuestionResponse(request, response);
}

export function toV3QuestionRequest(payload: unknown): unknown {
  const request = payload as {
    questions?: readonly {
      question: string;
      header?: string;
      body?: string;
      options: readonly { label: string; description?: string }[];
      multiSelect?: boolean;
      otherLabel?: string;
      otherDescription?: string;
    }[];
  };
  if (request.questions === undefined) return undefined;
  return {
    questions: request.questions.map((item, i) => ({
      id: `q_${i}`,
      question: item.question,
      header: item.header,
      body: item.body,
      options: item.options.map((option, j) => ({
        id: `opt_${i}_${j}`,
        label: option.label,
        description: option.description,
      })),
      multi_select: item.multiSelect,
      allow_other: true,
      other_label: item.otherLabel,
      other_description: item.otherDescription,
    })),
  };
}

function mapQuestionResponse(request: unknown, response: unknown): unknown {
  const r = response as { answers?: unknown; method?: unknown } | null;
  if (r === null || typeof r !== 'object' || r.answers === null || typeof r.answers !== 'object') {
    return undefined;
  }
  const items =
    (
      request as
        | {
            questions?: readonly {
              id: string;
              question: string;
              options: readonly { id: string; label: string }[];
            }[];
          }
        | undefined
    )?.questions ?? [];
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r.answers as Record<string, unknown>)) {
    const item = items.find((q) => q.id === key || q.question === key);
    if (item === undefined) continue;
    if (value === true) {
      answers[item.id] = { kind: 'skipped' };
      continue;
    }
    if (typeof value !== 'string') continue;
    const single = item.options.find((o) => o.label === value);
    if (single !== undefined) {
      answers[item.id] = { kind: 'single', option_id: single.id };
      continue;
    }
    const parts = value.split(', ');
    const optionIds = parts.flatMap((part) => {
      const found = item.options.find((o) => o.label === part);
      return found === undefined ? [] : [found.id];
    });
    if (parts.length > 1 && optionIds.length === parts.length) {
      answers[item.id] = { kind: 'multi', option_ids: optionIds };
      continue;
    }
    answers[item.id] = { kind: 'other', text: value };
  }
  if (Object.keys(answers).length === 0) return undefined;
  const method = r.method;
  return {
    answers,
    method:
      method === 'enter' || method === 'space' || method === 'number_key' || method === 'click'
        ? method
        : undefined,
  };
}
