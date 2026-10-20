export type TurnOrigin =
  | { kind: 'user'; payload?: unknown }
  | { kind: 'cron'; taskId?: string; payload?: unknown }
  | { kind: 'task'; taskId: string; payload?: unknown }
  | { kind: 'hook'; payload?: unknown }
  | { kind: 'compaction'; payload?: unknown }
  | { kind: 'side'; payload?: unknown }
  | { kind: 'other'; payload?: unknown };

export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StepState = 'running' | 'completed' | 'interrupted' | 'failed';

export interface TranscriptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cost?: number;
}

export interface StepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface TranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly triggerPromptId?: string;
  readonly ordinal: number;
  readonly state: TurnState;
  readonly origin: TurnOrigin;
  readonly prompt?: string;
  readonly attachmentIds?: readonly string[];
  readonly steps: TranscriptStep[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: TranscriptUsage;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface TranscriptStep {
  readonly kind: 'step';
  readonly stepId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly state: StepState;
  readonly frames: TranscriptFrame[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: StepUsage;
  readonly finishReason?: string;
}

export type TranscriptUserOrigin =
  | {
      readonly kind: 'user';
      readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
      readonly skillActivations?: readonly { readonly skillName: string; readonly skillArgs?: string }[];
    }
  | {
      readonly kind: 'skill_activation';
      readonly trigger: 'user-slash';
      readonly skillName: string;
      readonly skillArgs?: string;
      readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
    };

interface TextFrameBase {
  readonly kind: 'text';
  readonly frameId: string;
  readonly text: string;
  readonly attachmentIds?: readonly string[];
  readonly taskId?: string;
  readonly promptIds?: readonly string[];
}

export interface AssistantTextFrame extends TextFrameBase {
  readonly role: 'assistant';
}

export interface UserTextFrame extends TextFrameBase {
  readonly role: 'user';
  readonly origin?: TranscriptUserOrigin;
}

export type TextFrame = AssistantTextFrame | UserTextFrame;

export interface ThinkingFrame {
  readonly kind: 'thinking';
  readonly frameId: string;
  readonly text: string;
}

export type ToolFrameState = 'running' | 'done' | 'error';

export interface ToolFrameProgress {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface AgentRef {
  readonly agentId: string;
  readonly role?: 'child' | 'member';
}

export interface ToolCallFrame {
  readonly kind: 'tool';
  readonly frameId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly state: ToolFrameState;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly display?: unknown;
  readonly error?: string;
  readonly inputText?: string;
  readonly progress?: ToolFrameProgress;
  readonly taskId?: string;
  readonly approvalId?: string;
  readonly todoId?: string;
  readonly agentRefs?: readonly AgentRef[];
}

export interface NoticeFrame {
  readonly kind: 'notice';
  readonly frameId: string;
  readonly level: 'error' | 'warning' | 'info';
  readonly source?: string;
  readonly message: string;
  readonly detail?: unknown;
}

export type TranscriptFrame = TextFrame | ThinkingFrame | ToolCallFrame | NoticeFrame;

export interface TranscriptMarker {
  readonly kind: 'marker';
  readonly markerId: string;
  readonly marker: string;
  readonly payload?: unknown;
  readonly at?: string;
}

export interface TranscriptTaskRef {
  readonly kind: 'taskref';
  readonly refId: string;
  readonly taskId: string;
  readonly at?: string;
}

export type TranscriptItem = TranscriptTurn | TranscriptMarker | TranscriptTaskRef;

export type TaskKind = 'shell' | 'subagent' | 'tool' | 'other';

export type TaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';

export interface TranscriptTask {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly state: TaskState;
  readonly detached: boolean;
  readonly description?: string;
  readonly agentId?: string;
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly stateReason?: string;
  readonly usage?: StepUsage;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export type InteractionKind = 'approval' | 'question';

export type InteractionState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'answered'
  | 'dismissed';

export interface TranscriptInteraction {
  readonly interactionId: string;
  readonly interactionKind: InteractionKind;
  readonly toolCallId?: string;
  readonly state: InteractionState;
  readonly request?: unknown;
  readonly response?: unknown;
}

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export interface TranscriptTodo {
  readonly todoId: string;
  readonly items: readonly TodoItem[];
  readonly updatedAt?: string;
}

export type AttachmentSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly fileId: string }
  | { readonly kind: 'session_media'; readonly fileId: string };

export interface TranscriptAttachment {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly size?: number;
  readonly source?: AttachmentSource;
  readonly placeholder?: string;
}

export type TranscriptPromptStatus =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface TranscriptPrompt {
  readonly promptId: string;
  readonly status: TranscriptPromptStatus;
  readonly userMessageId?: string;
  readonly content?: unknown;
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly steeredAt?: string;
}

export interface GoalMeta {
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete';
  readonly completionCriterion?: string;
  readonly budgetUsed?: number;
  readonly budgetLimit?: number;
}

export interface ModesMetaMerge {
  readonly plan?: { readonly reviewPath?: string; readonly version?: number } | null;
  readonly swarm?: { readonly trigger?: string } | null;
  readonly tower?: Record<string, never> | null;
}

export type ActivityMeta = 'idle' | 'turn' | 'disposing' | 'unknown';

export interface AgentUsageMeta {
  readonly byModel?: Readonly<Record<string, StepUsage>>;
  readonly currentTurn?: StepUsage;
  readonly total?: StepUsage;
}

export interface AgentStatusMeta {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly usage?: AgentUsageMeta;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly permission?: 'manual' | 'yolo' | 'auto';
  readonly phase?: unknown;
}

export interface TranscriptMeta {
  readonly goal?: GoalMeta;
  readonly modes?: {
    readonly plan?: { readonly reviewPath?: string; readonly version?: number };
    readonly swarm?: { readonly trigger?: string };
    readonly tower?: Record<string, never>;
  };
  readonly activity?: ActivityMeta;
  readonly agent?: AgentStatusMeta;
}

export type TranscriptMetaMerge = Omit<TranscriptMeta, 'modes' | 'goal'> & {
  readonly modes?: ModesMetaMerge;
  readonly goal?: GoalMeta | null;
};

export interface AgentTranscriptSnapshot {
  readonly items: readonly TranscriptItem[];
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly prompts: readonly TranscriptPrompt[];
  readonly meta: TranscriptMeta;
  readonly hasMoreOlder?: boolean;
}

export type TurnHeader = Omit<TranscriptTurn, 'steps'>;
export type StepHeader = Omit<TranscriptStep, 'frames'>;

export type AppendTarget =
  | { readonly type: 'frame'; readonly turnId: string; readonly stepId: string; readonly frameId: string }
  | { readonly type: 'task'; readonly taskId: string };

export type TranscriptOperation =
  | { readonly op: 'reset'; readonly agentId: string; readonly snapshot: AgentTranscriptSnapshot }
  | { readonly op: 'turn.upsert'; readonly turn: TurnHeader }
  | { readonly op: 'step.upsert'; readonly turnId: string; readonly step: StepHeader }
  | { readonly op: 'frame.upsert'; readonly turnId: string; readonly stepId: string; readonly frame: TranscriptFrame }
  | { readonly op: 'append'; readonly target: AppendTarget; readonly offset: number; readonly text: string }
  | { readonly op: 'marker.upsert'; readonly item: TranscriptMarker; readonly beforeTurn?: number }
  | { readonly op: 'taskref.upsert'; readonly item: TranscriptTaskRef; readonly beforeTurn?: number }
  | { readonly op: 'task.upsert'; readonly task: TranscriptTask }
  | { readonly op: 'interaction.upsert'; readonly interaction: TranscriptInteraction }
  | { readonly op: 'attachment.upsert'; readonly attachment: TranscriptAttachment }
  | { readonly op: 'todo.upsert'; readonly todo: TranscriptTodo }
  | { readonly op: 'prompt.upsert'; readonly prompt: TranscriptPrompt }
  | { readonly op: 'meta.merge'; readonly meta: TranscriptMetaMerge }
  | { readonly op: 'items.remove'; readonly ids: readonly string[] };

export type TranscriptGrade = 'off' | 'turn' | 'block' | 'delta';

export const GRADE_RANK: Readonly<Record<TranscriptGrade, number>> = {
  off: 0,
  turn: 1,
  block: 2,
  delta: 3,
};

export type TranscriptGradeSpec = Readonly<Record<string, TranscriptGrade | undefined>>;

export function gradeFor(spec: TranscriptGradeSpec | undefined, agentId: string): TranscriptGrade {
  if (spec === undefined) return 'off';
  return spec[agentId] ?? spec['*'] ?? 'off';
}

export function needsResetOnTransition(prev: TranscriptGrade, next: TranscriptGrade): boolean {
  return GRADE_RANK[next] > GRADE_RANK[prev];
}

export function detachGrades(
  spec: TranscriptGradeSpec | undefined,
  agentIds: readonly string[],
): TranscriptGradeSpec | undefined {
  if (spec === undefined) return undefined;
  const next: Record<string, TranscriptGrade | undefined> = { ...spec };
  for (const agentId of agentIds) {
    if (agentId === '*') delete next['*'];
    else next[agentId] = 'off';
  }
  return Object.values(next).some((grade) => grade !== undefined && grade !== 'off')
    ? next
    : undefined;
}

export function filterOpsForGrade(
  grade: TranscriptGrade,
  ops: readonly TranscriptOperation[],
): TranscriptOperation[] {
  const rank = GRADE_RANK[grade];
  if (rank === 0) return [];
  return ops.filter((op) => {
    if (op.op === 'append') return rank >= GRADE_RANK.delta;
    if (op.op === 'step.upsert' || op.op === 'frame.upsert') return rank >= GRADE_RANK.block;
    return true;
  });
}

export function redactSnapshotForGrade(
  grade: TranscriptGrade,
  snapshot: AgentTranscriptSnapshot,
): AgentTranscriptSnapshot {
  if (GRADE_RANK[grade] >= GRADE_RANK.block) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (item.kind === 'turn' ? { ...item, steps: [] } : item)),
  };
}
