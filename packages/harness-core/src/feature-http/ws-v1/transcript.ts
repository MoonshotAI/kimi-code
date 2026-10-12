import type {
  AssistantEntry,
  ContentPart,
  HistoryMessage,
  PromptOrigin,
  ToolCall,
  UserEntry,
} from '@moonshot-ai/agent-core';

import type {
  AgentTranscriptSnapshot,
  StepHeader,
  StepUsage,
  TodoItem,
  ToolCallFrame,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptMarker,
  TranscriptMeta,
  TranscriptMetaMerge,
  TranscriptOperation,
  TranscriptPrompt,
  TranscriptStep,
  TranscriptTask,
  TranscriptTaskRef,
  TranscriptTodo,
  TranscriptTurn,
  TurnHeader,
  TurnOrigin,
} from './transcriptModel';

export function groupHistoryIntoSnapshot(
  history: readonly HistoryMessage[],
): AgentTranscriptSnapshot {
  const items: TranscriptItem[] = [];
  const attachments: TranscriptAttachment[] = [];
  let turn: TranscriptTurn | undefined;
  let nextOrdinal = 0;

  const foldOpening = (entry: UserEntry): { text: string; attachmentIds?: string[] } => {
    const ids: string[] = [];
    const texts: string[] = [];
    for (const part of entry.message.content) {
      if (part.type === 'text') {
        texts.push(part.text);
        continue;
      }
      const attachment = attachmentFromPart(part, attachments.length);
      if (attachment !== undefined) {
        attachments.push(attachment);
        ids.push(attachment.attachmentId);
      }
    }
    const origin = entry.meta?.origin;
    if (origin !== undefined && 'attachments' in origin) {
      for (const file of (origin as { attachments?: readonly { name: string; mediaType: string; size: number }[] })
        .attachments ?? []) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: file.mediaType,
          name: file.name,
          size: file.size,
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      }
    }
    return { text: texts.join(''), attachmentIds: ids.length > 0 ? ids : undefined };
  };

  const syncTurn = (next: TranscriptTurn): void => {
    const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === next.turnId);
    if (index >= 0) items[index] = next;
  };

  for (const entry of history) {
    const message = entry.message;
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const opening = foldOpening(entry as UserEntry);
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      turn = {
        kind: 'turn',
        turnId: `t${ordinal}`,
        ordinal,
        state: 'completed',
        origin: mapTurnOrigin((entry as UserEntry).meta?.origin),
        prompt: opening.text.length > 0 ? opening.text : undefined,
        attachmentIds: opening.attachmentIds,
        triggerPromptId: (entry as UserEntry).meta?.promptId,
        steps: [],
      };
      items.push(turn);
      continue;
    }
    if (message.role === 'assistant') {
      if (turn === undefined) {
        const ordinal = nextOrdinal;
        nextOrdinal += 1;
        turn = {
          kind: 'turn',
          turnId: `t${ordinal}`,
          ordinal,
          state: 'completed',
          origin: { kind: 'other' },
          steps: [],
        };
        items.push(turn);
      }
      const stepOrdinal = turn.steps.length + 1;
      const currentTurn = turn;
      const frames: TranscriptFrame[] = [];
      let frameCount = 0;
      const nextFrameId = (): string => {
        frameCount += 1;
        return `${currentTurn.turnId}.${stepOrdinal}.f${frameCount}`;
      };
      for (const part of message.content) {
        if (part.type === 'text' && part.text.length > 0) {
          frames.push({ kind: 'text', frameId: nextFrameId(), role: 'assistant', text: part.text });
        } else if (part.type === 'think' && part.think.length > 0 && part.hidden !== true) {
          frames.push({ kind: 'thinking', frameId: nextFrameId(), text: part.think });
        }
      }
      for (const call of message.toolCalls) {
        frames.push({
          kind: 'tool',
          frameId: `${turn.turnId}.${stepOrdinal}.${call.id}`,
          toolCallId: call.id,
          name: call.name,
          state: 'running',
          input: parseToolArgs(call.arguments),
        });
      }
      const step: TranscriptStep = {
        kind: 'step',
        stepId: `${turn.turnId}.${stepOrdinal}`,
        turnId: turn.turnId,
        ordinal: stepOrdinal,
        state: 'completed',
        frames,
      };
      turn = { ...turn, steps: [...turn.steps, step] };
      syncTurn(turn);
      continue;
    }
    if (message.role === 'tool') {
      if (turn === undefined) continue;
      const toolCallId = (message as { toolCallId?: string }).toolCallId;
      if (toolCallId === undefined) continue;
      const output = textOfParts(message.content);
      const isError = (entry as { meta?: { isError?: true } }).meta?.isError === true;
      for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
        const step = turn.steps[s] as TranscriptStep;
        const index = step.frames.findIndex(
          (frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId,
        );
        if (index < 0) continue;
        const frame = step.frames[index] as ToolCallFrame;
        const patched: ToolCallFrame = {
          ...frame,
          state: isError ? 'error' : 'done',
          output,
          error: isError ? output : undefined,
        };
        const frames = [...step.frames];
        frames[index] = patched;
        turn = {
          ...turn,
          steps: turn.steps.map((candidate, i) =>
            i === s ? { ...candidate, frames } : candidate,
          ),
        };
        syncTurn(turn);
        break;
      }
    }
  }

  return { items, tasks: [], interactions: [], attachments, todos: [], prompts: [], meta: {} };
}

function attachmentFromPart(
  part: ContentPart,
  index: number,
): TranscriptAttachment | undefined {
  if (part.type === 'image_url' || part.type === 'video_url' || part.type === 'audio_url') {
    const target =
      part.type === 'image_url' ? part.imageUrl : part.type === 'video_url' ? part.videoUrl : part.audioUrl;
    const name = 'name' in target && typeof target.name === 'string' ? target.name : undefined;
    return {
      attachmentId: `att_${index + 1}`,
      mediaType: `${part.type.slice(0, part.type.indexOf('_'))}/*`,
      name,
      source: { kind: 'url', url: target.url },
    };
  }
  return undefined;
}

function textOfParts(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is ContentPart & { type: 'text' } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function mapTurnOrigin(origin: PromptOrigin | undefined): TurnOrigin {
  const kind = origin?.kind;
  switch (kind) {
    case undefined:
    case 'user':
      return { kind: 'user', payload: origin };
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (origin as { jobId?: unknown }).jobId;
      return { kind: 'cron', taskId: typeof jobId === 'string' ? jobId : undefined, payload: origin };
    }
    case 'task':
    case 'background_task': {
      const taskId = (origin as { taskId?: unknown }).taskId;
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

export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string' || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

export function projectPromptContent(parts: readonly ContentPart[]): unknown[] {
  const out: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      out.push({
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
        name: part.imageUrl.name,
      });
    } else if (part.type === 'video_url') {
      out.push({
        type: 'video',
        source: { kind: 'url', url: part.videoUrl.url },
        name: part.videoUrl.name,
      });
    }
  }
  return out;
}

export interface TurnPageQuery {
  readonly beforeTurn?: string;
  readonly afterTurn?: string;
  readonly pageSize: number;
}

export interface TurnPage {
  readonly items: readonly TranscriptItem[];
  readonly hasMore: boolean;
}

export function paginateTurns(items: readonly TranscriptItem[], query: TurnPageQuery): TurnPage {
  const pageSize = Math.max(1, query.pageSize);
  const segments = splitSegments(items);
  if (segments.length === 0) return { items: [], hasMore: false };

  if (query.afterTurn !== undefined) {
    const after = query.afterTurn;
    return pageSegments(
      segments.filter((seg) => seg.turnId !== undefined && compareTurnIds(seg.turnId, after) > 0),
      pageSize,
      'newer',
    );
  }
  if (query.beforeTurn !== undefined) {
    const before = query.beforeTurn;
    const older = segments.filter(
      (seg) => seg.turnId === undefined || compareTurnIds(seg.turnId, before) < 0,
    );
    return pageSegments(older, pageSize, 'older');
  }
  return pageSegments(segments, pageSize, 'older');
}

function compareTurnIds(a: string, b: string): number {
  return turnOrdinal(a) - turnOrdinal(b);
}

function turnOrdinal(id: string): number {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : 0;
}

interface Segment {
  readonly items: readonly TranscriptItem[];
  readonly turnId?: string;
}

function splitSegments(items: readonly TranscriptItem[]): Segment[] {
  const segments: Segment[] = [];
  let current: TranscriptItem[] = [];
  let currentTurn: string | undefined;
  const flush = (): void => {
    if (current.length > 0) segments.push({ items: current, turnId: currentTurn });
    current = [];
    currentTurn = undefined;
  };
  for (const item of items) {
    if (item.kind === 'turn') {
      flush();
      current = [item];
      currentTurn = item.turnId;
    } else {
      current.push(item);
    }
  }
  flush();
  return segments;
}

function pageSegments(
  segments: readonly Segment[],
  pageSize: number,
  direction: 'older' | 'newer',
): TurnPage {
  const head = segments[0]?.turnId === undefined ? segments[0] : undefined;
  const turnSegments = head !== undefined ? segments.slice(1) : segments;
  if (direction === 'older') {
    const selected = turnSegments.slice(-pageSize);
    const reachesFirstTurn = selected.length === turnSegments.length;
    const hasMore = turnSegments.length > selected.length && selected.length > 0;
    return {
      items: [...(reachesFirstTurn && head !== undefined ? head.items : []), ...selected.flatMap((seg) => seg.items)],
      hasMore,
    };
  }
  const selected = turnSegments.slice(0, pageSize);
  const hasMore = turnSegments.length > selected.length && selected.length > 0;
  return { items: selected.flatMap((seg) => seg.items), hasMore };
}

export function snapshotToOps(snapshot: AgentTranscriptSnapshot): TranscriptOperation[] {  const ops: TranscriptOperation[] = [];
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      const { steps, ...header } = item;
      ops.push({ op: 'turn.upsert', turn: header });
      for (const step of steps) {
        const { frames, ...stepHeader } = step;
        ops.push({ op: 'step.upsert', turnId: item.turnId, step: stepHeader });
        for (const frame of frames) {
          ops.push({ op: 'frame.upsert', turnId: item.turnId, stepId: step.stepId, frame });
        }
      }
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  for (const interaction of snapshot.interactions) {
    ops.push({ op: 'interaction.upsert', interaction });
  }
  for (const todo of snapshot.todos) {
    ops.push({ op: 'todo.upsert', todo });
  }
  for (const prompt of snapshot.prompts) {
    ops.push({ op: 'prompt.upsert', prompt });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

interface OpenTextFrame {
  frameId: string;
  offset: number;
  text: string;
}

export class AgentTranscript {
  private items: TranscriptItem[] = [];
  private readonly tasks = new Map<string, TranscriptTask>();
  private readonly interactions = new Map<string, TranscriptInteraction>();
  private readonly attachments = new Map<string, TranscriptAttachment>();
  private readonly todos = new Map<string, TranscriptTodo>();
  private readonly prompts = new Map<string, TranscriptPrompt>();
  private meta: TranscriptMeta = {};

  constructor(readonly agentId: string) {}

  getItems(): readonly TranscriptItem[] {
    return this.items;
  }

  getTurn(turnId: string): TranscriptTurn | undefined {
    for (const item of this.items) {
      if (item.kind === 'turn' && item.turnId === turnId) return item;
    }
    return undefined;
  }

  getPrompt(promptId: string): TranscriptPrompt | undefined {
    return this.prompts.get(promptId);
  }

  getInteraction(interactionId: string): TranscriptInteraction | undefined {
    return this.interactions.get(interactionId);
  }

  getTask(taskId: string): TranscriptTask | undefined {
    return this.tasks.get(taskId);
  }

  stepFrames(turnId: string, stepId: string): readonly TranscriptFrame[] | undefined {
    return this.getTurn(turnId)?.steps.find((step) => step.stepId === stepId)?.frames;
  }

  toolFrame(
    toolCallId: string,
  ): { turnId: string; stepId: string; frame: ToolCallFrame } | undefined {
    for (const item of this.items) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
            return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
      }
    }
    return undefined;
  }

  snapshot(): AgentTranscriptSnapshot {
    return {
      items: this.items,
      tasks: [...this.tasks.values()],
      interactions: [...this.interactions.values()],
      attachments: [...this.attachments.values()],
      todos: [...this.todos.values()],
      prompts: [...this.prompts.values()],
      meta: this.meta,
    };
  }

  apply(ops: readonly TranscriptOperation[]): void {
    for (const op of ops) this.applyOne(op);
  }

  private applyOne(op: TranscriptOperation): void {
    switch (op.op) {
      case 'reset': {
        this.items = [...op.snapshot.items];
        this.tasks.clear();
        for (const task of op.snapshot.tasks) this.tasks.set(task.taskId, task);
        this.interactions.clear();
        for (const interaction of op.snapshot.interactions) {
          this.interactions.set(interaction.interactionId, interaction);
        }
        this.attachments.clear();
        for (const attachment of op.snapshot.attachments) {
          this.attachments.set(attachment.attachmentId, attachment);
        }
        this.todos.clear();
        for (const todo of op.snapshot.todos) this.todos.set(todo.todoId, todo);
        this.prompts.clear();
        for (const prompt of op.snapshot.prompts) this.prompts.set(prompt.promptId, prompt);
        this.meta = op.snapshot.meta;
        return;
      }
      case 'turn.upsert': {
        const index = this.items.findIndex(
          (item) => item.kind === 'turn' && item.turnId === op.turn.turnId,
        );
        if (index >= 0) {
          const current = this.items[index] as TranscriptTurn;
          this.items[index] = { ...current, ...op.turn, steps: current.steps };
          return;
        }
        const turn: TranscriptTurn = { ...op.turn, steps: [] };
        const after = this.items.findIndex(
          (item) => item.kind === 'turn' && item.ordinal > turn.ordinal,
        );
        if (after >= 0) this.items.splice(after, 0, turn);
        else this.items.push(turn);
        return;
      }
      case 'step.upsert': {
        const turn = this.mutableTurn(op.turnId) ?? this.adoptTurn(op.turnId);
        const index = turn.steps.findIndex((step) => step.stepId === op.step.stepId);
        if (index >= 0) {
          const current = turn.steps[index] as TranscriptStep;
          turn.steps[index] = { ...current, ...op.step, frames: current.frames };
          return;
        }
        const step: TranscriptStep = { ...op.step, frames: [] };
        const after = turn.steps.findIndex((candidate) => candidate.ordinal > step.ordinal);
        if (after >= 0) turn.steps.splice(after, 0, step);
        else turn.steps.push(step);
        return;
      }
      case 'frame.upsert': {
        const turn = this.mutableTurn(op.turnId) ?? this.adoptTurn(op.turnId);
        let step = turn.steps.find((candidate) => candidate.stepId === op.stepId);
        if (step === undefined) {
          const ordinal = Number(op.stepId.split('.').at(-1)) || turn.steps.length + 1;
          step = {
            kind: 'step',
            stepId: op.stepId,
            turnId: op.turnId,
            ordinal,
            state: 'running',
            frames: [],
          };
          turn.steps.push(step);
        }
        const index = step.frames.findIndex((frame) => frame.frameId === op.frame.frameId);
        if (index >= 0) step.frames[index] = op.frame;
        else step.frames.push(op.frame);
        return;
      }
      case 'append': {
        if (op.target.type === 'task') {
          const task = this.tasks.get(op.target.taskId);
          if (task !== undefined) {
            this.tasks.set(op.target.taskId, { ...task, outputTail: task.outputTail + op.text });
          }
          return;
        }
        const target = this.frameAt(op.target);
        if (target === undefined) return;
        const { step, index } = target;
        const frame = step.frames[index] as TranscriptFrame;
        if (frame.kind === 'text' || frame.kind === 'thinking') {
          step.frames[index] = { ...frame, text: frame.text + op.text };
        }
        return;
      }
      case 'marker.upsert':
        this.items.push(op.item);
        return;
      case 'taskref.upsert':
        this.items.push(op.item);
        return;
      case 'task.upsert':
        this.tasks.set(op.task.taskId, op.task);
        return;
      case 'interaction.upsert':
        this.interactions.set(op.interaction.interactionId, op.interaction);
        return;
      case 'attachment.upsert':
        this.attachments.set(op.attachment.attachmentId, op.attachment);
        return;
      case 'todo.upsert':
        this.todos.set(op.todo.todoId, op.todo);
        return;
      case 'prompt.upsert':
        this.prompts.set(op.prompt.promptId, op.prompt);
        return;
      case 'meta.merge':
        this.meta = mergeMeta(this.meta, op.meta);
        return;
      case 'items.remove': {
        const ids = new Set(op.ids);
        this.items = this.items.filter((item) => {
          if (item.kind === 'turn') return !ids.has(item.turnId);
          if (item.kind === 'marker') return !ids.has(item.markerId);
          return !ids.has(item.refId);
        });
        return;
      }
    }
  }

  private mutableTurn(turnId: string): TranscriptTurn | undefined {
    for (const item of this.items) {
      if (item.kind === 'turn' && item.turnId === turnId) return item;
    }
    return undefined;
  }

  private adoptTurn(turnId: string): TranscriptTurn {
    const ordinal = Number(turnId.slice(1)) || this.items.length;
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId,
      ordinal,
      state: 'running',
      origin: { kind: 'other' },
      steps: [],
    };
    this.items.push(turn);
    return turn;
  }

  private frameAt(target: {
    turnId: string;
    stepId: string;
    frameId: string;
  }): { step: TranscriptStep; index: number } | undefined {
    const turn = this.mutableTurn(target.turnId);
    const step = turn?.steps.find((candidate) => candidate.stepId === target.stepId);
    if (step === undefined) return undefined;
    const index = step.frames.findIndex((frame) => frame.frameId === target.frameId);
    return index >= 0 ? { step, index } : undefined;
  }
}

function mergeMeta(base: TranscriptMeta, patch: TranscriptMetaMerge): TranscriptMeta {
  const next: {
    -readonly [K in keyof TranscriptMeta]?: TranscriptMeta[K];
  } = { ...base };
  if (patch.activity !== undefined) next.activity = patch.activity;
  if (patch.agent !== undefined) next.agent = { ...next.agent, ...patch.agent };
  if ('goal' in patch) next.goal = patch.goal === null ? undefined : patch.goal;
  if (patch.modes !== undefined) {
    const modes: {
      plan?: { readonly reviewPath?: string; readonly version?: number };
      swarm?: { readonly trigger?: string };
      tower?: Record<string, never>;
    } = { ...next.modes };
    if ('plan' in patch.modes) modes.plan = patch.modes.plan === null ? undefined : patch.modes.plan;
    if ('swarm' in patch.modes)
      modes.swarm = patch.modes.swarm === null ? undefined : patch.modes.swarm;
    if ('tower' in patch.modes)
      modes.tower = patch.modes.tower === null ? undefined : patch.modes.tower;
    next.modes = modes;
  }
  return next;
}

const TASK_OUTPUT_TAIL_LIMIT = 8000;

function tailOf(text: string | undefined): string {
  if (text === undefined) return '';
  return text.length > TASK_OUTPUT_TAIL_LIMIT ? text.slice(-TASK_OUTPUT_TAIL_LIMIT) : text;
}

export interface ProjectorTurn {
  readonly turnId: string;
  readonly ordinal: number;
}

export class AgentTranscriptProjector {
  private currentTurn: TurnHeader | undefined;
  private currentStep: StepHeader | undefined;
  private frameOrdinal = 0;
  private attachmentOrdinal = 0;
  private openText: OpenTextFrame | undefined;
  private openThinking: OpenTextFrame | undefined;
  private readonly stepUsageByTurn = new Map<string, StepUsage[]>();
  private markerSeq = 0;
  private readonly subagentTaskIds = new Map<string, string>();
  private readonly shellTasks = new Map<string, string>();

  constructor(readonly agentId: string, private readonly transcript: AgentTranscript) {}

  get activeTurnId(): number | undefined {
    return this.currentTurn?.ordinal;
  }

  get activeStepOrdinal(): number | undefined {
    return this.currentStep?.ordinal;
  }

  map(event: Record<string, unknown>): TranscriptOperation[] {
    switch (event['type']) {
      case 'turn.started':
        return this.onTurnStarted(event);
      case 'turn.done':
        return this.onTurnEnded(event);
      case 'step.started':
        return this.onStepStarted(event);
      case 'llm.done':
        return this.onLlmDone(event);
      case 'llm.streaming.usage':
        return this.onStreamingUsage(event);
      case 'llm.streaming.part':
        return this.onStreamingPart(event);
      case 'turn.spawn_tools':
        return this.onSpawnTools(event);
      case 'tool.update':
        return this.onToolProgress(event);
      case 'tool.done':
        return this.onToolResult(event);
      case 'prompt.submitted':
        return this.onPromptSubmitted(event);
      case 'turn.prompt_committed':
        return this.onPromptStarted(event);
      case 'prompt.steered':
        return this.onPromptSteered(event);
      case 'prompt.blocked':
        return this.onPromptBlocked(event);
      case 'agent.failed':
        return [this.noticeOp('error', messageOf(event['error']), { error: String(event['error']) })];
      case 'task.started':
      case 'task.settled':
        return this.onTaskLifecycle(event);
      case 'todo.updated':
        return this.onTodoUpdated(event);
      case 'interaction.requested':
        return this.onInteractionRequested(event);
      case 'interaction.resolved':
        return this.onInteractionResolved(event);
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
        return [
          this.markerOp('compaction', {
            phase: (event['type'] as string).slice('compaction.'.length),
            ...restOf(event),
          }),
        ];
      case 'skill.activated':
        return [this.markerOp('skill', restOf(event))];
      case 'cron.fired':
        return [this.markerOp('cron.fired', restOf(event))];
      case 'goal.updated':
        return this.onGoalUpdated(event);
      case 'shell.started':
        return this.onShellStarted(event);
      case 'shell.output':
        return this.onShellOutput(event);
      case 'shell.completed':
        return this.onShellCompleted(event);
      case 'tower.spawned':
        return this.onSubagentSpawned(event);
      case 'tower.completed':
      case 'tower.failed':
      case 'tower.cancelled':
        return this.onSubagentRun(event);
      default:
        return [];
    }
  }

  private onTurnStarted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const ordinal = event['turnId'] as number;
    const turnId = `t${ordinal}`;
    const entry = event['entry'] as UserEntry | undefined;
    const ops: TranscriptOperation[] = [];
    const attachmentIds: string[] = [];
    if (entry !== undefined) {
      for (const part of entry.message.content) {
        const attachment = attachmentFromPart(part, this.attachmentOrdinal);
        if (attachment !== undefined) {
          this.attachmentOrdinal += 1;
          ops.push({ op: 'attachment.upsert', attachment });
          attachmentIds.push(attachment.attachmentId);
        }
      }
      const origin = entry.meta?.origin;
      if (origin !== undefined && 'attachments' in origin) {
        for (const file of (origin as { attachments?: readonly { name: string; mediaType: string; size: number }[] })
          .attachments ?? []) {
          this.attachmentOrdinal += 1;
          const attachment: TranscriptAttachment = {
            attachmentId: `${turnId}.att${this.attachmentOrdinal}`,
            mediaType: file.mediaType,
            name: file.name,
            size: file.size,
          };
          ops.push({ op: 'attachment.upsert', attachment });
          attachmentIds.push(attachment.attachmentId);
        }
      }
    }
    const prompt = entry === undefined ? undefined : textOfParts(entry.message.content);
    this.currentTurn = {
      kind: 'turn',
      turnId,
      triggerPromptId: entry?.meta?.promptId,
      ordinal,
      state: 'running',
      origin: mapTurnOrigin(entry?.meta?.origin),
      prompt: prompt !== undefined && prompt.length > 0 ? prompt : undefined,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      startedAt: nowIso(),
    };
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    ops.push({ op: 'meta.merge', meta: { activity: 'turn' } });
    return ops;
  }

  private onTurnEnded(event: { [key: string]: unknown }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event['turnId'] as number}`;
    if (this.currentStep !== undefined && this.currentStep.state === 'running') {
      const step: StepHeader = { ...this.currentStep, state: 'interrupted', endedAt: nowIso() };
      this.currentStep = step;
      ops.push({ op: 'step.upsert', turnId, step });
    }
    const outcome = event['outcome'] as
      | { type: 'done' }
      | { type: 'failed'; failure: { reason: string; message?: string; error?: unknown } }
      | { type: 'aborted'; reason?: unknown };
    const state =
      outcome.type === 'done' ? 'completed' : outcome.type === 'failed' ? 'failed' : 'cancelled';
    const error =
      outcome.type === 'failed'
        ? outcome.failure.reason === 'max_steps'
          ? outcome.failure.message
          : String(outcome.failure.error)
        : undefined;
    const prev =
      this.currentTurn?.turnId === turnId ? this.currentTurn : this.transcript.getTurn(turnId);
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: event['turnId'] as number,
      state,
      triggerPromptId: prev?.triggerPromptId,
      origin: prev?.origin ?? { kind: 'other' },
      prompt: prev?.prompt,
      attachmentIds: prev?.attachmentIds,
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      error,
      usage: this.takeTurnUsage(turnId),
    };
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    const promptId = prev?.triggerPromptId ?? this.currentTurn.triggerPromptId;
    if (promptId !== undefined) {
      ops.push({
        op: 'prompt.upsert',
        prompt: this.buildPrompt(promptId, state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'aborted', true),
      });
    }
    ops.push({ op: 'meta.merge', meta: { activity: 'idle' } });
    this.currentStep = undefined;
    return ops;
  }

  private onStepStarted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const turnId = `t${event['turnId'] as number}`;
    const ordinal = event['step'] as number;
    const stepId = `${turnId}.${ordinal}`;
    this.flushOpenFramesInto();
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal,
      state: 'running',
      startedAt: nowIso(),
    };
    this.frameOrdinal = 0;
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private onLlmDone(event: { [key: string]: unknown }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const entry = event['entry'] as AssistantEntry;
    const turnId = this.currentTurn?.turnId ?? `t0`;
    const step = this.ensureStep(turnId, ops);
    this.reconcileEntryFrames(ops, turnId, step, entry);
    const usage = entry.meta?.usage;
    const finish = entry.meta?.finish as { reason?: string } | undefined;
    const completed: StepHeader = {
      kind: 'step',
      stepId: step.stepId,
      turnId,
      ordinal: step.ordinal,
      state: 'completed',
      startedAt: step.startedAt,
      endedAt: nowIso(),
      usage:
        usage !== undefined
          ? {
              inputOther: usage.inputOther ?? 0,
              output: usage.output ?? 0,
              inputCacheRead: usage.inputCacheRead ?? 0,
              inputCacheCreation: usage.inputCacheCreation ?? 0,
            }
          : undefined,
      finishReason: finish?.reason,
    };
    if (usage !== undefined) {
      const usages = this.stepUsageByTurn.get(turnId) ?? [];
      usages.push(completed.usage as StepUsage);
      this.stepUsageByTurn.set(turnId, usages);
    }
    this.currentStep = completed;
    ops.push({ op: 'step.upsert', turnId, step: completed });
    return ops;
  }

  private reconcileEntryFrames(
    ops: TranscriptOperation[],
    turnId: string,
    step: StepHeader,
    entry: AssistantEntry,
  ): void {
    const streamedText = (this.openText?.text.length ?? 0) > 0 || (this.openThinking?.text.length ?? 0) > 0;
    const existing = this.transcript.stepFrames(turnId, step.stepId) ?? [];
    const hasText = existing.some(
      (frame) => (frame.kind === 'text' && frame.role === 'assistant') || frame.kind === 'thinking',
    );
    if (!streamedText && !hasText) {
      for (const part of entry.message.content) {
        if (part.type === 'text' && part.text.length > 0) {
          ops.push({
            op: 'frame.upsert',
            turnId,
            stepId: step.stepId,
            frame: {
              kind: 'text',
              frameId: `${step.stepId}.f${++this.frameOrdinal}`,
              role: 'assistant',
              text: part.text,
            },
          });
        } else if (part.type === 'think' && part.think.length > 0 && part.hidden !== true) {
          ops.push({
            op: 'frame.upsert',
            turnId,
            stepId: step.stepId,
            frame: {
              kind: 'thinking',
              frameId: `${step.stepId}.f${++this.frameOrdinal}`,
              text: part.think,
            },
          });
        }
      }
    }
    for (const call of entry.message.toolCalls ?? []) {
      if (this.transcript.toolFrame(call.id) !== undefined) continue;
      const frame: ToolCallFrame = {
        kind: 'tool',
        frameId: `${step.stepId}.${call.id}`,
        toolCallId: call.id,
        name: call.name,
        state: 'running',
        input: parseToolArgs(call.arguments),
      };
      ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    }
  }

  private onStreamingUsage(event: { [key: string]: unknown }): TranscriptOperation[] {
    const turnId = this.currentTurn?.turnId;
    if (turnId === undefined) return [];
    const usage = event['usage'] as
      | { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number }
      | undefined;
    if (usage === undefined) return [];
    const usages = this.stepUsageByTurn.get(turnId) ?? [];
    usages.push({
      inputOther: usage.inputOther ?? 0,
      output: usage.output ?? 0,
      inputCacheRead: usage.inputCacheRead ?? 0,
      inputCacheCreation: usage.inputCacheCreation ?? 0,
    });
    this.stepUsageByTurn.set(turnId, usages);
    return [];
  }

  private onStreamingPart(event: { [key: string]: unknown }): TranscriptOperation[] {
    const part = event['part'] as
      | ContentPart
      | ToolCall
      | { type: 'tool_call_part'; argumentsPart: string | null; index?: number | string };
    if (part.type === 'text') return this.onTextDelta('assistant', part.text);
    if (part.type === 'think') {
      if (part.hidden === true || part.think.length === 0) return [];
      return this.onTextDelta('thinking', part.think);
    }
    if (part.type === 'function') {
      return this.onToolCallDelta(part.id, part.name, part.arguments ?? '');
    }
    return [];
  }

  private onTextDelta(kind: 'assistant' | 'thinking', delta: string): TranscriptOperation[] {
    if (delta.length === 0) return [];
    const ops: TranscriptOperation[] = [];
    const turnId = this.currentTurn?.turnId ?? `t0`;
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

  private adoptStreamFrame(
    turnId: string,
    stepId: string,
    kind: 'assistant' | 'thinking',
  ): OpenTextFrame | undefined {
    const frames = this.transcript.stepFrames(turnId, stepId);
    if (frames === undefined || frames.length === 0) return undefined;
    for (const frame of frames) {
      const match = /\.f(\d+)$/.exec(frame.frameId);
      if (match !== null) this.frameOrdinal = Math.max(this.frameOrdinal, Number(match[1]));
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i] as TranscriptFrame;
      if (kind === 'assistant' && frame.kind === 'text' && frame.role === 'assistant') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
      if (kind === 'thinking' && frame.kind === 'thinking') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
    }
    return undefined;
  }

  private flushOpenFrames(ops: TranscriptOperation[]): void {
    const step = this.currentStep;
    for (const open of [this.openText, this.openThinking]) {
      if (open === undefined || step === undefined) continue;
      ops.push({
        op: 'frame.upsert',
        turnId: step.turnId,
        stepId: step.stepId,
        frame:
          open === this.openText
            ? { kind: 'text', frameId: open.frameId, role: 'assistant', text: open.text }
            : { kind: 'thinking', frameId: open.frameId, text: open.text },
      });
    }
    this.openText = undefined;
    this.openThinking = undefined;
  }

  private flushOpenFramesInto(): void {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    this.transcript.apply(ops);
  }

  private ensureStep(turnId: string, ops: TranscriptOperation[]): StepHeader {
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      return this.currentStep;
    }
    const ordinal = 1;
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

  private onSpawnTools(event: { [key: string]: unknown }): TranscriptOperation[] {
    const toolCalls = (event['toolCalls'] as ToolCall[] | undefined) ?? [];
    const ops: TranscriptOperation[] = [];
    for (const call of toolCalls) {
      ops.push(...this.onToolCallStarted(call));
    }
    return ops;
  }

  private onToolCallStarted(call: ToolCall): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = this.currentTurn?.turnId ?? `t0`;
    const step = this.ensureStep(turnId, ops);
    const existing = this.transcript.toolFrame(call.id);
    if (existing !== undefined) {
      const frame: ToolCallFrame = { ...existing.frame, input: parseToolArgs(call.arguments) };
      ops.push({ op: 'frame.upsert', turnId: existing.turnId, stepId: existing.stepId, frame });
      return ops;
    }
    const frameId = `${step.stepId}.${call.id}`;
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId,
      toolCallId: call.id,
      name: call.name,
      state: 'running',
      input: parseToolArgs(call.arguments),
    };
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private onToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string,
  ): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const existing = this.transcript.toolFrame(toolCallId);
    if (existing !== undefined) {
      const frame: ToolCallFrame = {
        ...existing.frame,
        inputText: (existing.frame.inputText ?? '') + argumentsPart,
      };
      ops.push({ op: 'frame.upsert', turnId: existing.turnId, stepId: existing.stepId, frame });
      return ops;
    }
    const turnId = this.currentTurn?.turnId ?? `t0`;
    const step = this.ensureStep(turnId, ops);
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId: `${step.stepId}.${toolCallId}`,
      toolCallId,
      name: name ?? '',
      state: 'running',
      inputText: argumentsPart,
    };
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private onToolProgress(event: { [key: string]: unknown }): TranscriptOperation[] {
    const toolCallId = event['toolCallId'] as string;
    const update = event['update'] as { key: string; text: string; percent?: number };
    const hit = this.transcript.toolFrame(toolCallId);
    if (hit === undefined) return [];
    const knownKind = ['stdout', 'stderr', 'progress', 'status'].includes(update.key);
    const frame: ToolCallFrame = {
      ...hit.frame,
      progress: {
        kind: (knownKind ? update.key : 'custom') as 'stdout' | 'stderr' | 'progress' | 'status' | 'custom',
        text: update.text,
        percent: update.percent,
        customKind: knownKind ? undefined : update.key,
      },
    };
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private onToolResult(event: { [key: string]: unknown }): TranscriptOperation[] {
    const toolCallId = event['toolCallId'] as string;
    const outcome = event['outcome'] as
      | { type: 'succeeded'; result: { content: ContentPart[]; isError?: true } }
      | { type: 'failed'; error: unknown }
      | { type: 'aborted'; reason?: unknown };
    const hit = this.transcript.toolFrame(toolCallId);
    if (hit === undefined) return [];
    const output =
      outcome.type === 'succeeded'
        ? outcome.result.content
        : outcome.type === 'failed'
          ? messageOf(outcome.error)
          : undefined;
    const isError =
      outcome.type === 'failed' || (outcome.type === 'succeeded' && outcome.result.isError === true);
    const frame: ToolCallFrame = {
      ...hit.frame,
      state: isError ? 'error' : 'done',
      output,
      error: isError && typeof output === 'string' ? output : undefined,
    };
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private onPromptSubmitted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const entry = event['entry'] as UserEntry;
    const promptId = entry.meta?.promptId;
    if (promptId === undefined) return [];
    const prev = this.transcript.getPrompt(promptId);
    const prompt: TranscriptPrompt = {
      promptId,
      status:
        prev !== undefined && isTerminalPromptStatus(prev.status) ? prev.status : 'running',
      userMessageId: entry.meta?.userMessageId,
      content: projectPromptContent(entry.message.content),
      createdAt: prev?.createdAt ?? entry.meta?.createdAt ?? nowIso(),
      finishedAt: prev?.finishedAt,
      steeredAt: prev?.steeredAt,
    };
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onPromptStarted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const entry = event['entry'] as UserEntry;
    const promptId = entry.meta?.promptId;
    if (promptId === undefined) return [];
    return [{ op: 'prompt.upsert', prompt: this.buildPrompt(promptId, 'running', false, entry) }];
  }

  private onPromptSteered(event: { [key: string]: unknown }): TranscriptOperation[] {
    const entries = (event['entries'] as UserEntry[] | undefined) ?? [];
    const ops: TranscriptOperation[] = [];
    const now = nowIso();
    for (const entry of entries) {
      const promptId = entry.meta?.promptId;
      if (promptId === undefined) continue;
      const prev = this.transcript.getPrompt(promptId);
      ops.push({
        op: 'prompt.upsert',
        prompt: {
          promptId,
          status: 'completed',
          userMessageId: prev?.userMessageId ?? entry.meta?.userMessageId,
          content: prev?.content ?? projectPromptContent(entry.message.content),
          createdAt: prev?.createdAt ?? entry.meta?.createdAt ?? now,
          finishedAt: now,
          steeredAt: now,
        },
      });
      if (this.currentStep !== undefined && this.currentStep.state === 'running') {
        const text = textOfParts(entry.message.content);
        if (text.length > 0) {
          ops.push({
            op: 'frame.upsert',
            turnId: this.currentStep.turnId,
            stepId: this.currentStep.stepId,
            frame: {
              kind: 'text',
              frameId: `${this.currentStep.stepId}.f${++this.frameOrdinal}`,
              role: 'user',
              text,
              promptIds: promptId !== undefined ? [promptId] : undefined,
              origin: { kind: 'user' },
            },
          });
        }
      }
    }
    return ops;
  }

  private onPromptBlocked(event: { [key: string]: unknown }): TranscriptOperation[] {
    const promptId = event['queueItemId'] as string | undefined;
    if (promptId === undefined) return [];
    return [{ op: 'prompt.upsert', prompt: this.buildPrompt(promptId, 'blocked', true) }];
  }

  private buildPrompt(
    promptId: string,
    status: TranscriptPrompt['status'],
    finished: boolean,
    entry?: UserEntry,
  ): TranscriptPrompt {
    const prev = this.transcript.getPrompt(promptId);
    return {
      promptId,
      status,
      userMessageId: prev?.userMessageId ?? entry?.meta?.userMessageId,
      content: prev?.content ?? (entry === undefined ? undefined : projectPromptContent(entry.message.content)),
      createdAt: prev?.createdAt ?? entry?.meta?.createdAt ?? nowIso(),
      finishedAt: finished ? nowIso() : prev?.finishedAt,
      steeredAt: prev?.steeredAt,
    };
  }

  private onTaskLifecycle(event: { [key: string]: unknown }): TranscriptOperation[] {
    const record = event['record'] as {
      taskId: string;
      toolName: string;
      description?: string;
      status: 'running' | 'completed' | 'failed' | 'killed' | 'lost';
      startedAt: number;
      endedAt?: number;
      stopReason?: string;
      output?: string;
    };
    const prev = this.transcript.getTask(record.taskId);
    const task: TranscriptTask = {
      taskId: record.taskId,
      kind: record.toolName === 'process' ? 'shell' : 'other',
      state: record.status,
      detached: true,
      description: record.description ?? prev?.description,
      outputTail: record.output !== undefined ? tailOf(record.output) : (prev?.outputTail ?? ''),
      startedAt: prev?.startedAt ?? epochMsToIso(record.startedAt),
      endedAt: record.endedAt === undefined ? prev?.endedAt : epochMsToIso(record.endedAt),
      stateReason: record.stopReason ?? prev?.stateReason,
    };
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (event['type'] === 'task.started') {
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${record.taskId}`, taskId: record.taskId, at: nowIso() },
      });
    }
    return ops;
  }

  private onTodoUpdated(event: { [key: string]: unknown }): TranscriptOperation[] {
    const items = (event['todos'] as TodoItem[] | undefined) ?? [];
    const todo: TranscriptTodo = { todoId: 'todo', items, updatedAt: nowIso() };
    return [{ op: 'todo.upsert', todo }];
  }

  private onInteractionRequested(event: { [key: string]: unknown }): TranscriptOperation[] {
    const interaction = event['interaction'] as {
      id: string;
      kind: string;
      payload: unknown;
      tags?: Record<string, string | number>;
      createdAt: number;
    };
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') return [];
    const toolCallId = interactionToolCallId(interaction);
    const entity: TranscriptInteraction = {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      toolCallId,
      state: 'pending',
      request: interaction.payload,
    };
    return [{ op: 'interaction.upsert', interaction: entity }];
  }

  private onInteractionResolved(event: { [key: string]: unknown }): TranscriptOperation[] {
    const id = event['id'] as string;
    const interaction = event['interaction'] as
      | { kind: string; payload: unknown; tags?: Record<string, string | number> }
      | undefined;
    const response = event['response'];
    if (interaction === undefined) return [];
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') return [];
    const state = mapInteractionEndState(interaction.kind, response);
    const toolCallId = interactionToolCallId(interaction);
    const prev = this.transcript.getInteraction(id);
    const ops: TranscriptOperation[] = [
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: id,
          interactionKind: interaction.kind,
          toolCallId: toolCallId ?? prev?.toolCallId,
          state,
          request: prev?.request,
          response,
        },
      },
    ];
    if (toolCallId !== undefined) {
      const hit = this.transcript.toolFrame(toolCallId);
      if (hit !== undefined) {
        ops.push({
          op: 'frame.upsert',
          turnId: hit.turnId,
          stepId: hit.stepId,
          frame: { ...hit.frame, approvalId: id },
        });
      }
    }
    return ops;
  }

  private onGoalUpdated(event: { [key: string]: unknown }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const snapshot = event['snapshot'] as
      | {
          objective: string;
          status: 'active' | 'paused' | 'blocked' | 'complete';
          completionCriterion?: string;
          tokensUsed: number;
          budget: { tokenBudget: number | null };
        }
      | null
      | undefined;
    if (snapshot === null || snapshot === undefined) {
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

  private onShellStarted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const commandId = event['commandId'] as string;
    const taskId = `shell-${commandId}`;
    this.shellTasks.set(commandId, taskId);
    const task: TranscriptTask = {
      taskId,
      kind: 'shell',
      state: 'running',
      detached: false,
      outputTail: '',
      startedAt: nowIso(),
    };
    return [
      { op: 'task.upsert', task },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: nowIso() },
      },
    ];
  }

  private shellTaskId(event: { [key: string]: unknown }): string {
    const commandId = event['commandId'] as string;
    const taskId = this.shellTasks.get(commandId) ?? `shell-${commandId}`;
    this.shellTasks.set(commandId, taskId);
    return taskId;
  }

  private onShellOutput(event: { [key: string]: unknown }): TranscriptOperation[] {
    const text = event['text'] as string | undefined;
    if (typeof text !== 'string' || text.length === 0) return [];
    const taskId = this.shellTaskId(event);
    const ops: TranscriptOperation[] = [];
    let task = this.transcript.getTask(taskId);
    if (task === undefined) {
      task = {
        taskId,
        kind: 'shell',
        state: 'running',
        detached: false,
        outputTail: '',
        startedAt: nowIso(),
      };
      ops.push(
        { op: 'task.upsert', task },
        {
          op: 'taskref.upsert',
          item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: nowIso() },
        },
      );
    }
    ops.push({ op: 'append', target: { type: 'task', taskId }, offset: task.outputTail.length, text });
    return ops;
  }

  private onShellCompleted(event: { [key: string]: unknown }): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const prev = this.transcript.getTask(taskId);
    const task: TranscriptTask = {
      taskId,
      kind: prev?.kind ?? 'shell',
      state: event['isError'] === true ? 'failed' : 'completed',
      detached: prev?.detached ?? false,
      description: prev?.description,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: nowIso(),
    };
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (prev === undefined) {
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: nowIso() },
      });
    }
    return ops;
  }

  private onSubagentSpawned(event: { [key: string]: unknown }): TranscriptOperation[] {
    const subagentId = event['agentId'] as string;
    const taskKey = subagentId;
    const prev = this.transcript.getTask(taskKey);
    const newGeneration = prev !== undefined && prev.state !== 'running';
    const task: TranscriptTask = {
      taskId: taskKey,
      kind: 'subagent',
      state: 'running',
      detached: true,
      description: (event['description'] as string | undefined) ?? prev?.description,
      agentId: subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: newGeneration ? nowIso() : (prev?.startedAt ?? nowIso()),
      endedAt: newGeneration ? undefined : prev?.endedAt,
      model: (event['model'] as string | undefined) ?? prev?.model,
    };
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (newGeneration || prev === undefined) {
      ops.push({
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: `ref-${taskKey}`, taskId: taskKey, at: nowIso() },
      });
    }
    return ops;
  }

  private onSubagentRun(event: { [key: string]: unknown }): TranscriptOperation[] {
    const subagentId = event['agentId'] as string;
    const terminal = event['type'] !== 'tower.started';
    const state =
      event['type'] === 'tower.completed' ? 'completed' : event['type'] === 'tower.failed' ? 'failed' : 'killed';
    const taskKey = this.subagentTaskIds.get(subagentId) ?? subagentId;
    const prev = this.transcript.getTask(taskKey);
    const usage = event['usage'] as
      | { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }
      | undefined;
    const task: TranscriptTask = {
      taskId: taskKey,
      kind: 'subagent',
      state,
      detached: prev?.detached ?? true,
      description: prev?.description,
      agentId: subagentId,
      outputTail: prev?.outputTail ?? '',
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: terminal ? nowIso() : prev?.endedAt,
      resultSummary: (event['summary'] as string | undefined) ?? prev?.resultSummary,
      usage: usage ?? prev?.usage,
      error: (event['error'] as string | undefined) ?? prev?.error,
      model: prev?.model,
      thinkingEffort: prev?.thinkingEffort,
    };
    return [{ op: 'task.upsert', task }];
  }

  private takeTurnUsage(turnId: string): { inputTokens: number; cachedTokens: number; outputTokens: number } | undefined {
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
}

function nowIso(): string {
  return new Date().toISOString();
}

function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

function restOf(event: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, time: _time, ...rest } = event;
  return rest;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interactionToolCallId(interaction: {
  payload: unknown;
  tags?: Record<string, string | number>;
}): string | undefined {
  const fromPayload = (interaction.payload as { toolCallId?: unknown } | undefined)?.toolCallId;
  if (typeof fromPayload === 'string') return fromPayload;
  const fromTags = interaction.tags?.['toolCallId'];
  return typeof fromTags === 'string' ? fromTags : undefined;
}

function isTerminalPromptStatus(status: TranscriptPrompt['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted' || status === 'blocked';
}

function mapInteractionEndState(
  kind: string,
  response: unknown,
): TranscriptInteraction['state'] {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  if (
    typeof response === 'object' &&
    response !== null &&
    (response as { cancelled?: unknown }).cancelled === true
  ) {
    return 'cancelled';
  }
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}
