import type {
  ApprovalRequest,
  ApprovalResponsePayload,
  AssistantDeltaMessage,
  AssistantMessage,
  InteractionMessage,
  QuestionRequest,
  QuestionResponsePayload,
  ServerMessage,
  SkillActivation,
  StepMessage,
  StepRetry,
  StepUsage,
  TaskMessage,
  TaskNotificationPayload,
  ThinkingDeltaMessage,
  ThinkingMessage,
  TodoItem,
  TodoMessage,
  ToolCallAgentRef,
  ToolCallMessage,
  ToolProgressPayload,
  TurnMessage,
  TurnOrigin,
  UserMessage,
  UserMessageOrigin,
} from '../../protocol/v2/messages/index';

export interface ProjectionEvent {
  type: string;
  time?: number;
  agentId?: string;
  promptId?: unknown;
  promptIds?: unknown;
  status?: unknown;
  steer?: unknown;
  content?: unknown;
  origin?: unknown;
  createdAt?: unknown;
  steeredAt?: unknown;
  finishedAt?: unknown;
  abortedAt?: unknown;
  turnId?: unknown;
  durationMs?: unknown;
  step?: unknown;
  usage?: unknown;
  finishReason?: unknown;
  llmFirstTokenLatencyMs?: unknown;
  llmStreamDurationMs?: unknown;
  reason?: unknown;
  message?: unknown;
  failedAttempt?: unknown;
  nextAttempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  errorName?: unknown;
  errorMessage?: unknown;
  statusCode?: unknown;
  delta?: unknown;
  toolCallId?: unknown;
  argumentsPart?: unknown;
  name?: unknown;
  args?: unknown;
  display?: unknown;
  update?: unknown;
  output?: unknown;
  isError?: unknown;
  key?: unknown;
  value?: unknown;
  info?: unknown;
  outputTail?: unknown;
  id?: unknown;
  toolName?: unknown;
  action?: unknown;
  toolInput?: unknown;
  decision?: unknown;
  feedback?: unknown;
  result?: unknown;
  turns?: unknown;
  fromTurnId?: unknown;
  taskId?: unknown;
  attachmentIds?: unknown;
  prompt?: unknown;
  summary?: unknown;
  planMode?: unknown;
  version?: unknown;
  snapshot?: unknown;
  agentRefs?: unknown;
  resultSummary?: unknown;
  lifecycle?: unknown;
  turn?: unknown;
  endedAt?: unknown;
  model?: unknown;
  thinkingEffort?: unknown;
  contextTokens?: unknown;
  maxContextTokens?: unknown;
  mode?: unknown;
  hookEvent?: unknown;
  blocked?: unknown;
  skillName?: unknown;
  commandName?: unknown;
  swarmMode?: unknown;
  [key: string]: unknown;
}

export interface InteractionPendingRecord {
  id: string;
  kind: 'approval' | 'question';
  toolCallId?: string;
  request: ApprovalRequest | QuestionRequest;
  time?: number;
}

export interface InteractionResolvedRecord {
  id: string;
  state: 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  response?: ApprovalResponsePayload | QuestionResponsePayload;
  time?: number;
}

interface TurnAcc {
  turnId: string;
  engineTurnId: number;
  origin: TurnOrigin;
  state: 'running' | 'completed';
  startedAt: string;
  userSeq: number;
  promptIds: string[];
  userMessageId?: string;
  attachmentIds?: string[];
  usageInput: number;
  usageOutput: number;
}

interface PromptAcc {
  promptId: string;
  messageId: string;
  turnId: string;
  text: string;
  createdAt: string;
  status: 'running' | 'completed';
  queued: boolean;
  steerHeld: boolean;
  emitted: boolean;
  origin?: UserMessageOrigin;
  attachmentIds?: string[];
  steeredAt?: string;
  notification?: TaskNotificationPayload;
  skillActivations?: SkillActivation[];
}

interface StepAcc {
  stepId: string;
  turnId: string;
  engineTurnId: number;
  ordinal: number;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt: string;
  endedAt?: number;
  usage?: StepUsage;
  finishReason?: string;
  retry?: StepRetry;
  endReason?: string;
  endMessage?: string;
  timing?: { llm_first_token_ms?: number; llm_stream_duration_ms?: number };
  textSeq: { a: number; h: number };
}

interface TextAcc {
  kind: 'assistant' | 'thinking';
  messageId: string;
  stepKey: string;
  turnId: string;
  stepId: string;
  text: string;
  announced: boolean;
}

interface ToolAcc {
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
  approvalId?: string;
  taskId?: string;
  todoId?: string;
  agentRefs?: ToolCallAgentRef[];
  opened: boolean;
}

interface TaskAcc {
  taskId: string;
  message: TaskMessage;
}

interface TaskInfoPayload {
  taskId?: unknown;
  kind?: unknown;
  status?: unknown;
  detached?: unknown;
  description?: unknown;
  startedAt?: unknown;
  model?: unknown;
  thinkingEffort?: unknown;
  endedAt?: unknown;
  resultSummary?: unknown;
  error?: unknown;
  stopReason?: unknown;
  usage?: unknown;
  outputTail?: unknown;
  childAgentId?: unknown;
}

interface InteractionAcc {
  id: string;
  kind: 'approval' | 'question';
  toolCallId?: string;
  request: ApprovalRequest | QuestionRequest;
  resolved?: boolean;
}

const MAIN_FALLBACK_TIME = 0;

function iso(time: number | undefined): string {
  return new Date(time ?? MAIN_FALLBACK_TIME).toISOString();
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => {
      const p = part as { type?: string; text?: unknown };
      return p?.type === 'text' && typeof p.text === 'string';
    })
    .map((part) => part.text)
    .join('');
}

export function toTurnOrigin(origin: unknown): TurnOrigin {
  const o = origin as { kind?: string } | undefined;
  switch (o?.kind) {
    case 'cron_job': {
      const c = o as { jobId?: string; cron?: string };
      return { kind: 'cron', cron_id: c.jobId ?? '', schedule: c.cron };
    }
    case 'task':
      return { kind: 'task', task_id: (o as { taskId?: string }).taskId ?? '' };
    case 'skill_activation':
      return { kind: 'skill', skill_name: (o as { skillName?: string }).skillName };
    case 'hook_result':
      return { kind: 'hook', name: (o as { event?: string }).event };
    case 'compaction_summary':
      return { kind: 'compaction' };
    case 'system_trigger': {
      const name = (o as { name?: string }).name;
      if (name === 'goal_continuation') return { kind: 'goal' };
      return { kind: 'other', name };
    }
    case 'side':
      return { kind: 'side' };
    case 'user':
    case undefined:
      return { kind: 'user' };
    default:
      return { kind: 'other', name: o?.kind };
  }
}

export function toUserOrigin(origin: unknown): UserMessageOrigin | undefined {
  const o = origin as
    | { kind?: string; jobId?: string; cron?: string; taskId?: string; skillName?: string; skillArgs?: string; trigger?: string }
    | undefined;
  if (o?.kind === 'cron_job') return { kind: 'cron', cron_id: o.jobId ?? '', schedule: o.cron ?? '' };
  if (o?.kind === 'task') return { kind: 'task', task_id: o.taskId ?? '' };
  if (o?.kind === 'skill_activation') {
    return { kind: 'skill', skill_name: o.skillName ?? '', args: o.skillArgs, trigger: o.trigger };
  }
  return undefined;
}

export function toSkillActivations(origin: unknown): SkillActivation[] | undefined {
  const list = (origin as { skillActivations?: unknown } | undefined)?.skillActivations;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: SkillActivation[] = [];
  for (const item of list) {
    const name = (item as { skillName?: unknown } | undefined)?.skillName;
    if (typeof name !== 'string' || name.length === 0) continue;
    const args = (item as { skillArgs?: unknown } | undefined)?.skillArgs;
    out.push({ skill_name: name, skill_args: typeof args === 'string' ? args : undefined });
  }
  return out.length > 0 ? out : undefined;
}

export function toStepUsage(usage: unknown): StepUsage | undefined {
  const u = usage as
    | { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number }
    | undefined;
  if (!u) return undefined;
  return {
    input_other: u.inputOther ?? 0,
    output: u.output ?? 0,
    input_cache_read: u.inputCacheRead ?? 0,
    input_cache_creation: u.inputCacheCreation ?? 0,
  };
}

function toToolProgress(update: unknown): ToolProgressPayload {
  const u = update as
    | { kind?: ToolProgressPayload['kind']; text?: string; percent?: number; customKind?: string; customData?: unknown }
    | undefined;
  return {
    kind: u?.kind ?? 'custom',
    text: u?.text,
    percent: u?.percent,
    custom_kind: u?.customKind,
    custom_data: u?.customData,
  };
}

export class AgentV2Projector {
  private maxTurnId = -1;
  private readonly turns = new Map<number, TurnAcc>();
  private readonly prompts = new Map<string, PromptAcc>();
  private readonly queue: string[] = [];
  private readonly steps = new Map<string, StepAcc>();
  private currentStep?: StepAcc;
  private openAssistant?: TextAcc;
  private openThinking?: TextAcc;
  private readonly tools = new Map<string, ToolAcc>();
  private readonly tasks = new Map<string, TaskAcc>();
  private readonly interactions = new Map<string, InteractionAcc>();
  private todoId?: string;
  private todoSeq = 0;
  private todoUpdatedAt?: number;
  private lastTodoItems?: TodoItem[];
  private systemSeq = 0;
  private planVersion?: number;
  private planKey?: string;
  private planExitApproved?: boolean;

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly turnIdPrefix = 't',
  ) {}

  apply(event: ProjectionEvent): ServerMessage[] {
    const out: ServerMessage[] = [];
    switch (event.type) {
      case 'prompt.submitted': this.onPromptSubmitted(event, out); break;
      case 'prompt.steered': this.onPromptSteered(event, out); break;
      case 'turn.steer': this.onTurnSteer(event, out); break;
      case 'prompt.started': this.onPromptStarted(event, out); break;
      case 'prompt.completed': this.onPromptCompleted(event, out); break;
      case 'prompt.aborted': this.onPromptAborted(event, out); break;
      case 'turn.started': this.onTurnStarted(event, out); break;
      case 'turn.ended': this.onTurnEnded(event, out); break;
      case 'turn.step.started': this.onStepStarted(event, out); break;
      case 'turn.step.completed': this.onStepCompleted(event, out); break;
      case 'turn.step.interrupted': this.onStepInterrupted(event, out); break;
      case 'turn.step.retrying': this.onStepRetrying(event, out); break;
      case 'assistant.delta': this.onTextDelta(event, 'assistant', out); break;
      case 'thinking.delta': this.onTextDelta(event, 'thinking', out); break;
      case 'tool.call.delta': this.onToolCallDelta(event, out); break;
      case 'tool.call.started': this.onToolCallStarted(event, out); break;
      case 'tool.progress': this.onToolProgress(event, out); break;
      case 'tool.result': this.onToolResult(event, out); break;
      case 'task.started': this.onTaskStarted(event, out); break;
      case 'task.terminated': this.onTaskTerminated(event, out); break;
      case 'task.notified': this.onTaskNotified(event, out); break;
      case 'tools.update_store': this.onToolsUpdateStore(event, out); break;
      case 'permission.approval.requested': this.onApprovalRequested(event, out); break;
      case 'permission.approval.resolved': this.onApprovalResolved(event, out); break;
      case 'compaction.completed': this.onCompactionCompleted(event, out); break;
      case 'context.undone': this.onContextUndone(event, out); break;
      case 'context.clear': this.onContextClear(event, out); break;
      case 'hook.result': this.onHookResult(event, out); break;
      case 'skill.activated': this.onSkillActivated(event, out); break;
      case 'plugin_command.activated': this.onPluginCommandActivated(event, out); break;
      case 'shell.output': this.onShellOutput(event, out); break;
      case 'agent.status.updated': this.onAgentStatusUpdated(event, out); break;
      case 'plan.revision': this.onPlanRevision(event, out); break;
      case 'goal.updated': this.onGoalUpdated(event, out); break;
      case 'cron.fired': this.onCronFired(event, out); break;
      case 'subagent.completed': this.onSubagentCompleted(event, out); break;
      default: break;
    }
    return out;
  }

  flushOpenTexts(time: number | undefined): ServerMessage[] {
    const out: ServerMessage[] = [];
    this.closeOpenTexts(time, out);
    return out;
  }

  applyInteractionPending(record: InteractionPendingRecord): ServerMessage[] {
    const out: ServerMessage[] = [];
    this.closeOpenTexts(record.time, out);
    const acc: InteractionAcc = {
      id: record.id,
      kind: record.kind,
      toolCallId: record.toolCallId,
      request: record.request,
    };
    this.interactions.set(acc.id, acc);
    out.push(this.interactionMessage(acc, 'pending', record.time));
    if (acc.toolCallId !== undefined) {
      const tool = this.tools.get(acc.toolCallId);
      if (tool) {
        tool.approvalId = acc.id;
        out.push(this.toolCallMessage(tool, record.time));
      }
    }
    return out;
  }

  applyInteractionResolved(record: InteractionResolvedRecord): ServerMessage[] {
    const acc = this.interactions.get(record.id);
    if (!acc) return [];
    acc.resolved = true;
    return [this.interactionMessage(acc, record.state, record.time, record.response)];
  }

  get turnCount(): number {
    return this.maxTurnId + 1;
  }

  recoveryEntities(now: () => number): ServerMessage[] {
    const out: ServerMessage[] = [];
    const turn = this.latestTurn();
    if (turn && turn.state === 'running') {
      out.push(this.turnMessage(turn, now()));
      const step = this.currentStep;
      if (step && step.state === 'running') {
        out.push(this.stepMessage(step, now()));
        if (this.openThinking) {
          out.push({ ...this.textMessage(this.openThinking, 'streaming', now()), text: this.openThinking.text });
        }
        if (this.openAssistant) {
          out.push({ ...this.textMessage(this.openAssistant, 'streaming', now()), text: this.openAssistant.text });
        }
        for (const acc of this.tools.values()) {
          if (acc.stepId === step.stepId && acc.state === 'running') out.push(this.toolCallMessage(acc, now()));
        }
      }
    }
    for (const acc of this.interactions.values()) {
      if (!acc.resolved) out.push(this.interactionMessage(acc, 'pending', now()));
    }
    for (const task of this.tasks.values()) {
      if (task.message.state === 'running') out.push({ ...task.message, timestamp: iso(now()) });
    }
    if (this.todoId !== undefined && this.lastTodoItems !== undefined) {
      out.push(this.todoMessage(this.todoId, this.lastTodoItems, now(), this.todoUpdatedAt));
    }
    for (const acc of this.prompts.values()) {
      if (acc.status === 'running' && acc.queued) out.push(this.userMessage(acc, now()));
    }
    return out;
  }

  private base(event: ProjectionEvent): { session_id: string; agent_id: string; timestamp: string } {
    return { session_id: this.sessionId, agent_id: this.agentId, timestamp: iso(event.time) };
  }

  private protocolTurnId(engineTurnId: number): string {
    return `${this.turnIdPrefix}${engineTurnId + 1}`;
  }

  private onPromptSubmitted(event: ProjectionEvent, out: ServerMessage[]): void {
    const promptId = event.promptId as string;
    const status = event.status as 'running' | 'queued';
    const steerHint = event.steer === true;
    const content = event.content;
    const origin = toUserOrigin(event.origin);
    const text = textFromContent(content);
    const createdAt = (event.createdAt as string) ?? iso(event.time);
    if (steerHint) {
      this.prompts.set(promptId, {
        promptId,
        messageId: '',
        turnId: '',
        text,
        createdAt,
        status: 'running',
        queued: true,
        steerHeld: true,
        emitted: false,
        origin,
      });
      return;
    }
    const queued = status === 'queued';
    if (queued) this.queue.push(promptId);
    const predictedEngineTurn = (event.turnId as number | undefined) ?? this.maxTurnId + this.queue.length + (queued ? 0 : 1);
    const turnId = this.protocolTurnId(predictedEngineTurn);
    const seq = this.nextUserSeq(predictedEngineTurn);
    const messageId = `${turnId}.u${seq}`;
    const acc: PromptAcc = {
      promptId,
      messageId,
      turnId,
      text,
      createdAt,
      status: 'running',
      queued,
      steerHeld: false,
      emitted: true,
      origin,
      attachmentIds: event.attachmentIds as string[] | undefined,
      skillActivations: toSkillActivations(event.origin),
    };
    this.prompts.set(promptId, acc);
    out.push(this.userMessage(acc, event.time));
  }

  private onCronFired(event: ProjectionEvent, out: ServerMessage[]): void {
    const promptId =
      (event.promptId as string | undefined) ?? `cron_${(event.origin as { jobId?: string } | undefined)?.jobId ?? ''}`;
    const turn = this.latestTurn();
    if (turn && turn.state === 'running') {
      const seq = turn.userSeq++;
      const acc: PromptAcc = {
        promptId,
        messageId: `${turn.turnId}.u${seq}`,
        turnId: turn.turnId,
        text: (event.prompt as string) ?? '',
        createdAt: iso(event.time),
        status: 'running',
        queued: false,
        steerHeld: false,
        emitted: true,
        origin: toUserOrigin(event.origin),
        steeredAt: iso(event.time),
      };
      this.prompts.set(promptId, acc);
      turn.promptIds.unshift(promptId);
      out.push(this.userMessage(acc, event.time));
      return;
    }
    this.onPromptSubmitted(
      {
        type: 'prompt.submitted',
        time: event.time,
        promptId,
        status: 'running',
        turnId: event.turnId,
        content: [{ type: 'text', text: (event.prompt as string) ?? '' }],
        createdAt: iso(event.time),
        origin: event.origin,
      },
      out,
    );
  }

  private onTaskNotified(event: ProjectionEvent, out: ServerMessage[]): void {
    const title = (event.title as string) ?? '';
    const body = (event.body as string) ?? '';
    const taskId = (event.sourceId as string) ?? '';
    const notification: TaskNotificationPayload = {
      title,
      body,
      severity: event.severity as string | undefined,
      type: event.notificationType as string | undefined,
      source_kind: event.sourceKind as string | undefined,
      source_id: taskId || undefined,
      agent_id: event.sourceAgentId as string | undefined,
      raw: event.raw as string | undefined,
    };
    const text = `${title}\n${body}`.trim();
    const turn = this.latestTurn();
    if (turn && turn.state === 'running') {
      const seq = turn.userSeq++;
      const acc: PromptAcc = {
        promptId: `task_${taskId}`,
        messageId: `${turn.turnId}.u${seq}`,
        turnId: turn.turnId,
        text,
        createdAt: iso(event.time),
        status: 'completed',
        queued: false,
        steerHeld: false,
        emitted: true,
        origin: { kind: 'task', task_id: taskId },
        notification,
      };
      this.prompts.set(acc.promptId, acc);
      out.push(this.userMessage(acc, event.time));
      return;
    }
    const engineTurnId = this.maxTurnId + 1;
    const turnId = this.protocolTurnId(engineTurnId);
    const seq = this.nextUserSeq(engineTurnId);
    const acc: PromptAcc = {
      promptId: `task_${taskId}`,
      messageId: `${turnId}.u${seq}`,
      turnId,
      text,
      createdAt: iso(event.time),
      status: 'completed',
      queued: false,
      steerHeld: false,
      emitted: true,
      origin: { kind: 'task', task_id: taskId },
      notification,
    };
    this.prompts.set(acc.promptId, acc);
    out.push(this.userMessage(acc, event.time));
  }

  private nextUserSeq(engineTurnId: number): number {
    const turn = this.turns.get(engineTurnId);
    if (turn) return turn.userSeq++;
    let seq = 0;
    for (const acc of this.prompts.values()) {
      if (acc.turnId === this.protocolTurnId(engineTurnId)) seq += 1;
    }
    return seq;
  }

  private onPromptSteered(event: ProjectionEvent, out: ServerMessage[]): void {
    const promptIds = (event.promptIds as string[]) ?? [];
    const steeredAt = (event.steeredAt as string) ?? iso(event.time);
    const turn = this.latestTurn();
    if (!turn) return;
    const contentText = textFromContent(event.content);
    for (const promptId of promptIds) {
      const held = this.prompts.get(promptId);
      const qi = this.queue.indexOf(promptId);
      if (qi >= 0) this.queue.splice(qi, 1);
      const seq = turn.userSeq++;
      const acc: PromptAcc = {
        promptId,
        messageId: `${turn.turnId}.u${seq}`,
        turnId: turn.turnId,
        text: held?.text ?? contentText,
        createdAt: held?.createdAt ?? steeredAt,
        status: 'running',
        queued: false,
        steerHeld: false,
        emitted: true,
        origin: held?.origin,
        steeredAt,
      };
      this.prompts.set(promptId, acc);
      turn.promptIds.push(promptId);
      out.push(this.userMessage(acc, event.time));
    }
  }

  private onTurnSteer(event: ProjectionEvent, out: ServerMessage[]): void {
    const origin = toUserOrigin(event.origin);
    if (origin?.kind !== 'skill') return;
    const text = textFromContent(event.input);
    const steeredAt = iso(event.time);
    const activationId = (event.origin as { activationId?: string } | undefined)?.activationId;
    const turn = this.latestTurn();
    if (turn && turn.state === 'running') {
      const seq = turn.userSeq++;
      const acc: PromptAcc = {
        promptId: `skill_${activationId ?? `${turn.turnId}.${seq}`}`,
        messageId: `${turn.turnId}.u${seq}`,
        turnId: turn.turnId,
        text,
        createdAt: steeredAt,
        status: 'running',
        queued: false,
        steerHeld: false,
        emitted: true,
        origin,
        steeredAt,
      };
      this.prompts.set(acc.promptId, acc);
      out.push(this.userMessage(acc, event.time));
      return;
    }
    const engineTurnId = this.maxTurnId + 1;
    const turnId = this.protocolTurnId(engineTurnId);
    const seq = this.nextUserSeq(engineTurnId);
    const acc: PromptAcc = {
      promptId: `skill_${activationId ?? turnId}`,
      messageId: `${turnId}.u${seq}`,
      turnId,
      text,
      createdAt: steeredAt,
      status: 'running',
      queued: false,
      steerHeld: false,
      emitted: true,
      origin,
      steeredAt,
    };
    this.prompts.set(acc.promptId, acc);
    out.push(this.userMessage(acc, event.time));
  }

  private onPromptStarted(event: ProjectionEvent, out: ServerMessage[]): void {
    const promptId = event.promptId as string;
    const acc = this.prompts.get(promptId);
    if (!acc || !acc.emitted) return;
    const qi = this.queue.indexOf(promptId);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (acc.queued) out.push(this.userMessage(acc, event.time));
    acc.queued = false;
  }

  private onPromptCompleted(event: ProjectionEvent, out: ServerMessage[]): void {
    const acc = this.prompts.get(event.promptId as string);
    if (!acc || acc.status === 'completed') return;
    acc.status = 'completed';
    if (!acc.emitted) this.assignHeld(acc, this.maxTurnId + 1);
    out.push(this.userMessage(acc, event.time, (event.finishedAt as string) ?? iso(event.time)));
  }

  private onPromptAborted(event: ProjectionEvent, out: ServerMessage[]): void {
    const acc = this.prompts.get(event.promptId as string);
    if (!acc) return;
    const qi = this.queue.indexOf(acc.promptId);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (acc.status !== 'completed') {
      acc.status = 'completed';
      if (!acc.emitted) this.assignHeld(acc, this.maxTurnId + 1);
      out.push(this.userMessage(acc, event.time, (event.abortedAt as string) ?? iso(event.time)));
    }
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'interruption',
      payload: { reason: 'aborted', turn_id: acc.turnId },
    });
  }

  private assignHeld(acc: PromptAcc, engineTurnId: number): void {
    const turnId = this.protocolTurnId(engineTurnId);
    const seq = this.nextUserSeq(engineTurnId);
    acc.messageId = `${turnId}.u${seq}`;
    acc.turnId = turnId;
    acc.emitted = true;
  }

  private onTurnStarted(event: ProjectionEvent, out: ServerMessage[]): void {
    const engineTurnId = event.turnId as number;
    this.maxTurnId = Math.max(this.maxTurnId, engineTurnId);
    const origin = toTurnOrigin(event.origin);
    const turn: TurnAcc = {
      turnId: this.protocolTurnId(engineTurnId),
      engineTurnId,
      origin,
      state: 'running',
      startedAt: iso(event.time),
      userSeq: 0,
      promptIds: [],
      usageInput: 0,
      usageOutput: 0,
    };
    let maxSeq = 0;
    for (const acc of this.prompts.values()) {
      if (acc.turnId === turn.turnId) maxSeq += 1;
    }
    turn.userSeq = maxSeq;
    const promptId = event.promptId as string | undefined;
    let heldAcc: PromptAcc | undefined;
    if (promptId) {
      const acc = this.prompts.get(promptId);
      if (acc && !acc.emitted) {
        this.assignHeld(acc, engineTurnId);
        heldAcc = acc;
      }
      turn.userMessageId = acc?.messageId ?? promptId;
      turn.promptIds.push(promptId);
      turn.attachmentIds = acc?.attachmentIds;
    }
    this.turns.set(engineTurnId, turn);
    if (maxSeq === 0 && heldAcc === undefined) {
      const userOrigin = toUserOrigin(event.origin);
      if (userOrigin !== undefined) {
        const seq = turn.userSeq++;
        const openingAcc: PromptAcc = {
          promptId: `turn_${turn.turnId}`,
          messageId: `${turn.turnId}.u${seq}`,
          turnId: turn.turnId,
          text: (event.prompt as string) ?? '',
          createdAt: iso(event.time),
          status: 'running',
          queued: false,
          steerHeld: false,
          emitted: true,
          origin: userOrigin,
          skillActivations: toSkillActivations(event.origin),
        };
        this.prompts.set(openingAcc.promptId, openingAcc);
        turn.userMessageId = openingAcc.messageId;
        heldAcc = openingAcc;
      }
    }
    out.push(this.turnMessage(turn, event.time));
    if (heldAcc) out.push(this.userMessage(heldAcc, event.time));
  }

  private onTurnEnded(event: ProjectionEvent, out: ServerMessage[]): void {
    const engineTurnId = event.turnId as number;
    const turn = this.turns.get(engineTurnId);
    if (!turn || turn.state === 'completed') return;
    turn.state = 'completed';
    this.closeOpenTexts(event.time, out);
    const usage =
      turn.usageInput > 0 || turn.usageOutput > 0
        ? {
            input_tokens: turn.usageInput,
            output_tokens: turn.usageOutput,
          }
        : undefined;
    const msg: TurnMessage = {
      type: 'turn',
      ...this.base(event),
      turn_id: turn.turnId,
      ordinal: turn.engineTurnId,
      state: 'completed',
      origin: turn.origin,
      user_message_id: turn.userMessageId,
      attachment_ids: turn.attachmentIds,
      started_at: turn.startedAt,
      ended_at: iso((event.endedAt as number | undefined) ?? event.time),
      usage,
      duration_ms: event.durationMs as number | undefined,
    };
    out.push(msg);
    for (const promptId of turn.promptIds) {
      const acc = this.prompts.get(promptId);
      if (acc && acc.status !== 'completed') {
        acc.status = 'completed';
        out.push(this.userMessage(acc, event.time, iso((event.endedAt as number | undefined) ?? event.time)));
      }
    }
  }

  private onStepStarted(event: ProjectionEvent, out: ServerMessage[]): void {
    const engineTurnId = event.turnId as number;
    const ordinal = (event.step as number) - 1;
    const turnId = this.protocolTurnId(engineTurnId);
    this.closeOpenTexts(event.time, out);
    const step: StepAcc = {
      stepId: `${turnId}.${ordinal}`,
      turnId,
      engineTurnId,
      ordinal,
      state: 'running',
      startedAt: iso(event.time),
      textSeq: { a: 0, h: 0 },
    };
    this.steps.set(step.stepId, step);
    this.currentStep = step;
    out.push(this.stepMessage(step, event.time));
  }

  private onStepCompleted(event: ProjectionEvent, out: ServerMessage[]): void {
    const step = this.currentStep;
    if (!step || step.state !== 'running') return;
    this.closeOpenTexts(event.time, out);
    step.state = 'completed';
    step.endedAt = (event.endedAt as number | undefined) ?? event.time;
    step.usage = toStepUsage(event.usage);
    step.finishReason = event.finishReason as string | undefined;
    step.retry = undefined;
    const timing = {
      llm_first_token_ms: event.llmFirstTokenLatencyMs as number | undefined,
      llm_stream_duration_ms: event.llmStreamDurationMs as number | undefined,
    };
    step.timing = timing.llm_first_token_ms !== undefined || timing.llm_stream_duration_ms !== undefined ? timing : undefined;
    const turn = this.turns.get(step.engineTurnId);
    if (turn && step.usage) {
      turn.usageInput += step.usage.input_other;
      turn.usageOutput += step.usage.output;
    }
    out.push(this.stepMessage(step, event.time));
    this.currentStep = undefined;
  }

  private onStepInterrupted(event: ProjectionEvent, out: ServerMessage[]): void {
    const step = this.currentStep;
    if (!step || step.state !== 'running') return;
    this.closeOpenTexts(event.time, out);
    step.state = 'interrupted';
    step.endedAt = (event.endedAt as number | undefined) ?? event.time;
    step.endReason = event.reason as string | undefined;
    step.endMessage = event.message as string | undefined;
    out.push(this.stepMessage(step, event.time));
    this.currentStep = undefined;
  }

  private onStepRetrying(event: ProjectionEvent, out: ServerMessage[]): void {
    const step = this.currentStep;
    if (!step) return;
    step.retry = {
      failed_attempt: event.failedAttempt as number,
      next_attempt: event.nextAttempt as number,
      max_attempts: event.maxAttempts as number,
      delay_ms: event.delayMs as number,
      error_name: event.errorName as string,
      error_message: event.errorMessage as string,
      status_code: event.statusCode as number | undefined,
    };
    this.resetOpenTexts();
    out.push(this.stepMessage(step, event.time));
  }

  private resetOpenTexts(): void {
    if (this.openAssistant) {
      this.openAssistant.text = '';
      this.openAssistant.announced = false;
    }
    if (this.openThinking) {
      this.openThinking.text = '';
      this.openThinking.announced = false;
    }
  }

  private onTextDelta(event: ProjectionEvent, kind: 'assistant' | 'thinking', out: ServerMessage[]): void {
    const delta = (event.delta as string) ?? '';
    const step = this.currentStep;
    if (!step) return;
    let acc = kind === 'assistant' ? this.openAssistant : this.openThinking;
    if (!acc && delta.length === 0) return;
    if (!acc || acc.stepKey !== step.stepId) {
      this.closeOpenTexts(event.time, out);
      const seq = kind === 'assistant' ? step.textSeq.a++ : step.textSeq.h++;
      acc = {
        kind,
        messageId: `${step.stepId}.${kind === 'assistant' ? 'a' : 'h'}${seq}`,
        stepKey: step.stepId,
        turnId: step.turnId,
        stepId: step.stepId,
        text: '',
        announced: false,
      };
      if (kind === 'assistant') this.openAssistant = acc;
      else this.openThinking = acc;
    }
    if (!acc.announced) {
      out.push(this.textMessage(acc, 'streaming', event.time));
      acc.announced = true;
    }
    acc.text += delta;
    if (delta.length === 0) return;
    if (kind === 'assistant') {
      const msg: AssistantDeltaMessage = { type: 'assistant.delta', ...this.base(event), message_id: acc.messageId, text: delta };
      out.push(msg);
    } else {
      const msg: ThinkingDeltaMessage = { type: 'thinking.delta', ...this.base(event), message_id: acc.messageId, text: delta };
      out.push(msg);
    }
  }

  private closeOpenTexts(time: number | undefined, out: ServerMessage[]): void {
    if (this.openAssistant) {
      out.push(this.textMessage(this.openAssistant, 'completed', time));
      this.openAssistant = undefined;
    }
    if (this.openThinking) {
      out.push(this.textMessage(this.openThinking, 'completed', time));
      this.openThinking = undefined;
    }
  }

  private onToolCallDelta(event: ProjectionEvent, out: ServerMessage[]): void {
    const toolCallId = event.toolCallId as string;
    const part = (event.argumentsPart as string) ?? '';
    this.closeOpenTexts(event.time, out);
    let acc = this.tools.get(toolCallId);
    if (!acc) {
      const step = this.currentStep;
      acc = {
        toolCallId,
        turnId: step?.turnId ?? '',
        stepId: step?.stepId ?? '',
        name: (event.name as string) ?? '',
        state: 'running',
        inputText: '',
        opened: false,
      };
      this.tools.set(toolCallId, acc);
    }
    acc.inputText = (acc.inputText ?? '') + part;
    out.push({
      type: 'tool_call.delta',
      ...this.base(event),
      tool_call_id: toolCallId,
      input_text: part,
    });
  }

  private onToolCallStarted(event: ProjectionEvent, out: ServerMessage[]): void {
    const toolCallId = event.toolCallId as string;
    const step = this.currentStep;
    this.closeOpenTexts(event.time, out);
    const prev = this.tools.get(toolCallId);
    const normalized = normalizeTodoToolCall((event.name as string) ?? prev?.name ?? '', event.args);
    const acc: ToolAcc = {
      toolCallId,
      turnId: step?.turnId ?? prev?.turnId ?? '',
      stepId: step?.stepId ?? prev?.stepId ?? '',
      name: normalized.name,
      state: 'running',
      input: normalized.input,
      inputText: prev?.inputText,
      display: event.display,
      agentRefs: (event.agentRefs as ToolCallAgentRef[] | undefined) ?? prev?.agentRefs,
      opened: true,
    };
    if (acc.name === 'TodoWrite' && todoItemsFromInput(acc.input) !== undefined) {
      this.todoId = this.todoId ?? this.nextTodoId();
      acc.todoId = this.todoId;
    }
    this.tools.set(toolCallId, acc);
    out.push(this.toolCallMessage(acc, event.time));
  }

  private onToolProgress(event: ProjectionEvent, out: ServerMessage[]): void {
    const toolCallId = event.toolCallId as string;
    const progress = toToolProgress(event.update);
    const acc = this.tools.get(toolCallId);
    if (acc) acc.progress = progress;
    out.push({ type: 'tool.progress', ...this.base(event), tool_call_id: toolCallId, progress });
  }

  private onToolResult(event: ProjectionEvent, out: ServerMessage[]): void {
    const toolCallId = event.toolCallId as string;
    const acc = this.tools.get(toolCallId);
    if (!acc) return;
    const isError = event.isError === true;
    acc.state = isError ? 'error' : 'done';
    acc.progress = undefined;
    if (isError) {
      acc.error = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
    } else {
      acc.output = event.output;
    }
    out.push(this.toolCallMessage(acc, event.time));
    if (!isError && acc.todoId !== undefined) this.todoUpdatedAt = event.time;
    if (!isError && acc.name === 'ExitPlanMode') {
      this.planExitApproved = (event.output as { approved?: boolean } | undefined)?.approved;
    }
  }

  private onToolsUpdateStore(event: ProjectionEvent, out: ServerMessage[]): void {
    if (event.key !== 'todo') return;
    const items = todoItemsFromList(event.value);
    if (!items) return;
    this.todoId = this.todoId ?? this.nextTodoId();
    this.lastTodoItems = items;
    out.push(this.todoMessage(this.todoId, items, event.time, this.todoUpdatedAt));
  }

  private onApprovalRequested(event: ProjectionEvent, out: ServerMessage[]): void {
    out.push(
      ...this.applyInteractionPending({
        id: event.id as string,
        kind: 'approval',
        toolCallId: event.toolCallId as string,
        request: { tool_name: event.toolName as string, input: event.toolInput, reason: event.action as string, display: event.display },
        time: event.time,
      }),
    );
  }

  private onApprovalResolved(event: ProjectionEvent, out: ServerMessage[]): void {
    const decision = event.decision as string;
    const state = decision === 'approved' || decision === 'rejected' || decision === 'cancelled' ? decision : 'cancelled';
    out.push(
      ...this.applyInteractionResolved({
        id: event.id as string,
        state,
        response: { decision: state, feedback: event.feedback as string | undefined },
        time: event.time,
      }),
    );
  }

  private onCompactionCompleted(event: ProjectionEvent, out: ServerMessage[]): void {
    const result = event.result as { tokensBefore?: number; tokensAfter?: number } | undefined;
    if (!result) return;
    const turn = this.latestTurn();
    const through = turn && turn.engineTurnId > 0 ? this.protocolTurnId(turn.engineTurnId - 1) : undefined;
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'compaction',
      payload: {
        before_tokens: result.tokensBefore as number,
        after_tokens: result.tokensAfter as number,
        summarized_through_turn: through,
      },
    });
  }

  private onContextUndone(event: ProjectionEvent, out: ServerMessage[]): void {
    const fromTurnId = event.fromTurnId as number | undefined;
    if (fromTurnId === undefined) return;
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'undo',
      payload: { undo_turn_id: this.protocolTurnId(fromTurnId) },
    });
  }

  private onAgentStatusUpdated(event: ProjectionEvent, out: ServerMessage[]): void {
    const planMode = event.planMode as boolean | undefined;
    if (planMode === true) {
      out.push({
        type: 'system',
        ...this.base(event),
        system_id: this.nextSystemId(),
        subtype: 'plan.enter',
        payload: { mode: 'plan' },
      });
    } else if (planMode === false) {
      out.push({
        type: 'system',
        ...this.base(event),
        system_id: this.nextSystemId(),
        subtype: 'plan.exit',
        payload: { approved: this.planExitApproved ?? false, version: this.planVersion, key: this.planKey },
      });
    }
    const swarmMode = event.swarmMode as boolean | undefined;
    if (swarmMode === true) {
      out.push({ type: 'system', ...this.base(event), system_id: this.nextSystemId(), subtype: 'swarm.enter' });
    } else if (swarmMode === false) {
      out.push({ type: 'system', ...this.base(event), system_id: this.nextSystemId(), subtype: 'swarm.exit' });
    }
  }

  private onContextClear(event: ProjectionEvent, out: ServerMessage[]): void {
    out.push({ type: 'system', ...this.base(event), system_id: this.nextSystemId(), subtype: 'clear' });
  }

  private onHookResult(event: ProjectionEvent, out: ServerMessage[]): void {
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'hook',
      payload: { event: event.hookEvent as string | undefined, content: event.content, blocked: event.blocked === true ? true : undefined },
    });
  }

  private onSkillActivated(event: ProjectionEvent, out: ServerMessage[]): void {
    if (event.trigger === 'user-slash') return;
    const origin = toUserOrigin({
      kind: 'skill_activation',
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      trigger: event.trigger,
    });
    const name = (event.skillName as string) ?? '';
    const args = (event.skillArgs as string | undefined) ?? '';
    const text = args.length > 0 ? `${name} ${args}` : name;
    const turn = this.latestTurn();
    if (turn && turn.state === 'running') {
      const seq = turn.userSeq++;
      const acc: PromptAcc = {
        promptId: `skill_${(event.activationId as string) ?? seq}`,
        messageId: `${turn.turnId}.u${seq}`,
        turnId: turn.turnId,
        text,
        createdAt: iso(event.time),
        status: 'completed',
        queued: false,
        steerHeld: false,
        emitted: true,
        origin,
      };
      this.prompts.set(acc.promptId, acc);
      out.push(this.userMessage(acc, event.time));
      return;
    }
    const engineTurnId = this.maxTurnId + 1;
    const turnId = this.protocolTurnId(engineTurnId);
    const seq = this.nextUserSeq(engineTurnId);
    const acc: PromptAcc = {
      promptId: `skill_${(event.activationId as string) ?? seq}`,
      messageId: `${turnId}.u${seq}`,
      turnId,
      text,
      createdAt: iso(event.time),
      status: 'completed',
      queued: false,
      steerHeld: false,
      emitted: true,
      origin,
    };
    this.prompts.set(acc.promptId, acc);
    out.push(this.userMessage(acc, event.time));
  }

  private onPluginCommandActivated(event: ProjectionEvent, out: ServerMessage[]): void {
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'notice',
      payload: { message: event.commandName as string | undefined },
    });
  }

  private onPlanRevision(event: ProjectionEvent, out: ServerMessage[]): void {
    this.closeOpenTexts(event.time, out);
    this.planVersion = event.version as number | undefined;
    this.planKey = event.key as string | undefined;
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'plan.revision',
      payload: {
        version: event.version as number,
        key: event.key as string | undefined,
        summary: event.summary as string | undefined,
      },
    });
  }

  private lastGoalStatus?: string;

  private onGoalUpdated(event: ProjectionEvent, out: ServerMessage[]): void {
    const snapshot = event.snapshot as { status?: string; objective?: string } | null | undefined;
    const status = snapshot?.status;
    if (status === this.lastGoalStatus) return;
    this.lastGoalStatus = status;
    if (!snapshot) return;
    out.push({
      type: 'system',
      ...this.base(event),
      system_id: this.nextSystemId(),
      subtype: 'goal',
      payload: { status: snapshot.status as string, objective: snapshot.objective },
    });
  }

  private onSubagentCompleted(event: ProjectionEvent, out: ServerMessage[]): void {
    const step = this.currentStep;
    if (!step) return;
    this.closeOpenTexts(event.time, out);
    const seq = step.textSeq.a++;
    const acc: TextAcc = {
      kind: 'assistant',
      messageId: `${step.stepId}.a${seq}`,
      stepKey: step.stepId,
      turnId: step.turnId,
      stepId: step.stepId,
      text: (event.resultSummary as string) ?? '',
      announced: true,
    };
    out.push(this.textMessage(acc, 'completed', event.time));
  }

  private onShellOutput(event: ProjectionEvent, out: ServerMessage[]): void {
    const taskId = event.taskId as string | undefined;
    if (taskId === undefined) return;
    const prev = this.tasks.get(taskId);
    if (!prev) return;
    const update = event.update as { text?: string } | undefined;
    const msg: TaskMessage = {
      ...prev.message,
      timestamp: iso(event.time),
      output_tail: update?.text ?? prev.message.output_tail,
    };
    this.tasks.set(taskId, { taskId, message: msg });
    out.push(msg);
  }

  private interactionMessage(
    acc: InteractionAcc,
    state: InteractionMessage['state'],
    time: number | undefined,
    response?: ApprovalResponsePayload | QuestionResponsePayload,
  ): InteractionMessage {
    const base = {
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      interaction_id: acc.id,
      state,
      tool_call_id: acc.toolCallId,
    };
    if (acc.kind === 'approval') {
      return {
        type: 'interaction',
        ...base,
        kind: 'approval',
        request: acc.request as ApprovalRequest,
        response: response as ApprovalResponsePayload | undefined,
      };
    }
    return {
      type: 'interaction',
      ...base,
      kind: 'question',
      request: acc.request as QuestionRequest,
      response: response as QuestionResponsePayload | undefined,
    };
  }

  private onTaskStarted(event: ProjectionEvent, out: ServerMessage[]): void {
    const info = event.info as TaskInfoPayload | undefined;
    if (!info) return;
    const taskId = info.taskId as string;
    const msg: TaskMessage = {
      type: 'task',
      ...this.base(event),
      task_id: taskId,
      kind: toTaskKind(info.kind as string | undefined),
      state: (info.status as TaskMessage['state']) ?? 'running',
      detached: info.detached === true,
      description: info.description as string | undefined,
      output_tail: (info.outputTail as string) ?? '',
      started_at: (info.startedAt as string) ?? iso(event.time),
      model: info.model as string | undefined,
      thinking_effort: info.thinkingEffort as string | undefined,
      child_agent_id: info.childAgentId as string | undefined,
    };
    this.tasks.set(taskId, { taskId, message: msg });
    out.push(msg);
  }

  private onTaskTerminated(event: ProjectionEvent, out: ServerMessage[]): void {
    const info = event.info as TaskInfoPayload | undefined;
    if (!info) return;
    const taskId = info.taskId as string;
    const prev = this.tasks.get(taskId)?.message;
    const msg: TaskMessage = {
      type: 'task',
      ...this.base(event),
      task_id: taskId,
      kind: toTaskKind(info.kind as string | undefined),
      state: (info.status as TaskMessage['state']) ?? 'completed',
      detached: prev?.detached ?? info.detached === true,
      description: (info.description as string | undefined) ?? prev?.description,
      output_tail: (event.outputTail as string) ?? prev?.output_tail ?? '',
      started_at: prev?.started_at ?? (info.startedAt as string | undefined),
      ended_at: (info.endedAt as string) ?? iso(event.time),
      result_summary: info.resultSummary as string | undefined,
      error: info.error as string | undefined,
      state_reason: info.stopReason as string | undefined,
      usage: toStepUsage(info.usage),
      model: prev?.model,
      thinking_effort: prev?.thinking_effort,
      child_agent_id: (info.childAgentId as string | undefined) ?? prev?.child_agent_id,
    };
    this.tasks.set(taskId, { taskId, message: msg });
    out.push(msg);
  }

  private latestTurn(): TurnAcc | undefined {
    return this.turns.get(this.maxTurnId);
  }

  private userMessage(acc: PromptAcc, time: number | undefined, finishedAt?: string): UserMessage {
    return {
      type: 'user',
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      message_id: acc.messageId,
      turn_id: acc.turnId,
      text: acc.text,
      status: acc.status,
      created_at: acc.createdAt,
      finished_at: acc.status === 'completed' ? (finishedAt ?? iso(time)) : undefined,
      steered_at: acc.steeredAt,
      origin: acc.origin,
      attachment_ids: acc.attachmentIds,
      notification: acc.notification,
      skill_activations: acc.skillActivations,
    };
  }

  private turnMessage(turn: TurnAcc, time: number | undefined): TurnMessage {
    return {
      type: 'turn',
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      turn_id: turn.turnId,
      ordinal: turn.engineTurnId,
      state: turn.state,
      origin: turn.origin,
      user_message_id: turn.userMessageId,
      attachment_ids: turn.attachmentIds,
      started_at: turn.startedAt,
    };
  }

  private stepMessage(step: StepAcc, time: number | undefined): StepMessage {
    return {
      type: 'step',
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      step_id: step.stepId,
      turn_id: step.turnId,
      ordinal: step.ordinal,
      state: step.state,
      started_at: step.startedAt,
      ended_at: step.state === 'running' ? undefined : iso(step.endedAt ?? time),
      usage: step.usage,
      finish_reason: step.finishReason,
      timing: step.timing,
      retry: step.retry,
      end_reason: step.endReason,
      end_message: step.endMessage,
    };
  }

  private textMessage(acc: TextAcc, status: 'streaming' | 'completed', time: number | undefined): AssistantMessage | ThinkingMessage {
    return {
      type: acc.kind,
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      message_id: acc.messageId,
      turn_id: acc.turnId,
      step_id: acc.stepId,
      status,
      text: status === 'streaming' ? '' : acc.text,
    };
  }

  private toolCallMessage(acc: ToolAcc, time: number | undefined): ToolCallMessage {
    return {
      type: 'tool_call',
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      tool_call_id: acc.toolCallId,
      turn_id: acc.turnId,
      step_id: acc.stepId,
      name: acc.name,
      state: acc.state,
      input: acc.input,
      output: acc.output,
      display: acc.display,
      error: acc.error,
      progress: acc.progress,
      approval_id: acc.approvalId,
      task_id: acc.taskId,
      todo_id: acc.todoId,
      agent_refs: acc.agentRefs,
    };
  }

  private todoMessage(todoId: string, items: TodoItem[], time: number | undefined, updatedAt?: number): TodoMessage {
    return {
      type: 'todo',
      session_id: this.sessionId,
      agent_id: this.agentId,
      timestamp: iso(time),
      todo_id: todoId,
      items,
      updated_at: iso(updatedAt ?? time),
    };
  }

  private nextTodoId(): string {
    this.todoSeq += 1;
    return `td_${String(this.todoSeq).padStart(2, '0')}`;
  }

  protected nextSystemId(): string {
    this.systemSeq += 1;
    return `m_${String(this.systemSeq).padStart(2, '0')}`;
  }
}

export function toTaskKind(kind: string | undefined): TaskMessage['kind'] {
  switch (kind) {
    case 'shell': return 'shell';
    case 'agent': return 'subagent';
    case 'tool': return 'tool';
    default: return 'other';
  }
}

export function normalizeTodoToolCall(name: string, input: unknown): { name: string; input: unknown } {
  if (name !== 'TodoList') return { name, input };
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  return { name: 'TodoWrite', input: todos === undefined ? input : { items: todos } };
}

export function todoItemsFromInput(input: unknown): TodoItem[] | undefined {
  const i = input as { todos?: unknown; items?: unknown } | undefined;
  return todoItemsFromList(i?.todos ?? i?.items);
}

export function todoItemsFromList(list: unknown): TodoItem[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of list) {
    const e = entry as { title?: string; content?: string; status?: string };
    const title = e.title ?? e.content;
    if (typeof title !== 'string') return undefined;
    items.push({
      title,
      status: e.status === 'in_progress' || e.status === 'done' ? e.status : 'pending',
    });
  }
  return items;
}
