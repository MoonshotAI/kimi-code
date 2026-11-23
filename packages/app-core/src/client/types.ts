
import type { AppTask, SessionPlan } from '../api/types';
import type { ConversationRequestDebug } from '../conversation/types';

export interface FileData {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
  truncated?: boolean;
}

export const FILE_PREVIEW_MAX_BYTES = 10_485_760;

export interface FileItem {
  path: string;
  name: string;
  kind?: 'file' | 'directory' | 'symlink';
  matchPositions?: number[];
}

export interface Session {
  id: string;
  title: string;
  time: string;
  busy: boolean;
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  updatedAt?: string;
  lastPrompt?: string;
  workspaceId?: string;
  workspaceName?: string;
  hostId?: string;
  pinned?: boolean;
  archived?: boolean;
  cwd?: string;
  cwdLabel?: string;
  pullRequest?: { number: number; state: 'open' | 'closed' | 'merged'; url: string } | null;
}

export interface Workspace {
  name: string;
  branch: string;
}

export interface WorkspaceView {
  id: string;
  name: string;
  root: string;
  hostId?: string;
  shortPath: string;
  additionalDirs: string[];
  sessionCount: number;
}

export interface WorkspaceGroup {
  workspace: WorkspaceView;
  sessions: Session[];
  hasMore: boolean;
  loadingMore: boolean;
  initialCount: number;
  pinnedCount: number;
}

export type PinnedEntry =
  | { key: string; kind: 'workspace'; group: WorkspaceGroup }
  | { key: string; kind: 'session'; session: Session };

export type WorkspaceScope = 'current' | 'all';

export type ToolStatus = 'ok' | 'running' | 'error' | 'cancelled';

export interface ToolCall {
  id: string;
  name: string;
  arg: string;
  status: ToolStatus;
  agentId?: string;
  startedAt?: string;
  timing?: string;
  output?: string[];
  resultText?: string;
  media?: ToolMedia;
  defaultExpanded?: boolean;
  planPath?: string;
  plan?: SessionPlan;
}

export interface ToolMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  path?: string;
  name?: string;
  mimeType?: string;
  bytes?: number;
  dimensions?: string;
  fileId?: string;
  sessionId?: string;
}

export interface OpenMediaRequest {
  media: ToolMedia;
  originImg?: HTMLImageElement | null;
  images?: ToolMedia[];
  imageIndex?: number;
}

export type AgentPhase = 'queued' | 'working' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface AgentMember {
  id: string;
  toolCallId?: string;
  name: string;
  kind?: AppTask['kind'];
  subagentType?: string;
  model?: string;
  thinkingEffort?: string;
  phase: AgentPhase;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  prompt?: string;
  outputLines?: string[];
  outputLoading?: boolean;
  outputUnavailable?: boolean;
  text?: string;
  suspendedReason?: string;
  swarmIndex?: number;
}

export interface DiffViewLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export type ApprovalBlock =
  | { kind: 'diff'; path: string; diff: DiffViewLine[] }
  | { kind: 'shell'; command: string; cwd?: string; danger?: string }
  | { kind: 'file'; path: string; content: string; language?: string }
  | { kind: 'fileop'; op: string; path: string; detail?: string; tool?: string }
  | { kind: 'url'; method?: string; url: string }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'invocation'; kind2: string; name: string; description?: string }
  | { kind: 'todo'; items: { title: string; status: string }[] }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string;
      options?: { label: string; description?: string }[];
    }
  | { kind: 'browser'; input: Record<string, unknown> }
  | { kind: 'generic'; summary: string };

export type TurnRole = 'user' | 'assistant' | 'compaction' | 'cron' | 'goal';

export interface FilePreviewRequest {
  path: string;
  line?: number;
  content?: string;
  urlSuffix?: string;
  assumed?: boolean;
}

export interface CronTurnData {
  jobId?: string;
  cron?: string;
  recurring?: boolean;
  coalescedCount?: number;
  stale?: boolean;
  missedCount?: number;
}

export interface TaskNotification {
  id: string;
  type: string;
  sourceKind: string;
  sourceId: string;
  agentId?: string;
  title: string;
  severity: string;
  body: string;
  outputFile?: { path: string; bytes?: number };
  outputPreview?: { text: string; bytes?: number; truncated?: boolean };
  questionAnswer?: { answers: Record<string, string | true>; note: string };
  raw: string;
  createdAt?: string;
}

export type TurnBlock = (
  | { kind: 'text'; text: string; final?: boolean }
  | {
      kind: 'thinking';
      thinking: string;
      startedAt?: string;
      durationMs?: number;
    }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'notification'; notification: TaskNotification }
) & { streaming?: boolean; debug?: readonly ConversationRequestDebug[] };

export interface TurnAttachment {
  kind: 'image' | 'video' | 'file';
  url: string;
  fileId?: string;
  sessionId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  mediaOrdinal?: number;
}

export interface CompactionTurnData {
  trigger?: 'manual' | 'auto';
  instruction?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface ChatTurn {
  id: string;
  clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  sessionId?: string;
  role: TurnRole;
  no: number;
  text: string;
  undoTurnId?: string;
  steered?: boolean;
  steerPhase?: 'sending' | 'accepted' | 'injected';
  promptIds?: readonly string[];
  thinking?: string;
  tools?: ToolCall[];
  blocks?: TurnBlock[];
  approval?: ApprovalBlock;
  approvalId?: string;
  daemonTurnId?: number;
  forkTurnIndex?: number;
  daemonTurnState?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attachments?: TurnAttachment[];
  inlineAttachments?: TurnAttachment[];
  compaction?: CompactionTurnData;
  createdAt?: string;
  endedAt?: string;
  durationMs?: number;
  skillActivation?: { name: string; path?: string; args?: string };
  skillActivations?: { name: string; path?: string; args?: string }[];
  pluginCommand?: { pluginId: string; commandName: string; args?: string };
  cron?: CronTurnData;
  goalContinuation?: boolean;
}

export interface TodoView {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type TaskState = 'run' | 'done' | 'fail' | 'cancelled';

export interface TaskItem {
  id: string;
  agentId?: string;
  name: string;
  kind: string;
  state: TaskState;
  timing: string;
  durationMs?: number;
  meta?: string;
  output?: string[];
  runInBackground?: boolean;
  parentToolCallId?: string;
  swarmIndex?: number;
  completedAt?: string;
  createdAt?: string;
  model?: string;
  thinkingEffort?: string;
}

export interface ConversationStatus {
  model: string;
  modelId: string;
  ctxUsed: number;
  ctxMax: number;
  permission?: 'manual' | 'auto' | 'yolo';
  branch: string;
  cwd: string;
  isGitRepo: boolean;
}

export interface ActivationBadges {
  plan: boolean;
  goal: { status: string; turnsUsed: number; elapsedMs: number } | null;
  swarm: { done: number; total: number } | null;
}

export interface QueuedPromptView {
  id: string;
  snapshot?: unknown;
  text: string;
  attachmentCount: number;
  attachments?: TurnAttachment[];
  editText?: string;
  kind?: 'prompt' | 'compact';
  instruction?: string;
}

export interface UIQuestion {
  questionId: string;
  sessionId: string;
  toolCallId?: string;
  questions: {
    id: string;
    question: string;
    header?: string;
    body?: string;
    options: { id: string; label: string; description?: string }[];
    multiSelect?: boolean;
    allowOther?: boolean;
    otherLabel?: string;
    otherDescription?: string;
  }[];
}

export type ActivityState =
  | 'idle'
  | 'running'
  | 'awaiting-approval'
  | 'awaiting-question';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type PermissionMode = 'manual' | 'auto' | 'yolo';

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
  oversize?: boolean;
  status?: string;
}
