import type {
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';

import type { NotificationsConfig } from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { Theme } from './theme';
import type { ResolvedTheme } from './theme/colors';

export interface AppState {
  model: string;
  workDir: string;
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  thinking: boolean;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing';
  streamingStartTime: number;
  theme: Theme;
  version: string;
  editorCommand: string | null;
  notifications: NotificationsConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  mcpServersSummary: string | null;
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: ToolInputDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
}

export type BackgroundAgentStatusPhase = 'started' | 'completed' | 'failed';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

export interface CompactionTranscriptData {
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'cron';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  color?: string;
  detail?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
}

export type LivePaneMode =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'session';

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface QueuedMessage {
  readonly text: string;
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from kimi-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
  resolvedTheme?: ResolvedTheme;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
