import type {
  GoalChange,
  GoalSnapshot,
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  SessionEnvironmentStatus,
  SessionEnvironmentType,
  ThinkingEffort,
  TokenUsage,
  ToolInputDisplay,
  WorkLocation,
} from '@moonshot-ai/kimi-code-sdk';

export type { WorkLocation };

import type {
  FollowUpBehavior,
  MarkdownConfig,
  MouseConfig,
  NotificationsConfig,
  SelectionCopyMode,
  StatusLineConfig,
  TranscriptConfig,
  TuiMode,
  UpgradePreferences,
} from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { ColorToken, ThemeName } from './theme';
import type { MediaAttachment, VideoAttachment } from './utils/image-attachment-store';

export type BannerDisplay = 'always' | 'once' | 'cooldown';

export interface BannerState {
  key: string;
  tag: string | null;
  mainText: string | null;
  subText: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

export interface EnvironmentSlotState {
  readonly environmentId: string;
  readonly type: SessionEnvironmentType;
  readonly status: SessionEnvironmentStatus;
  readonly cwd?: string;
  readonly connectError?: string;
}

export interface AppState {
  model: string;
  workDir: string;
  projectRoot?: string;
  isGitRepo?: boolean;
  worktree?: WorkLocation['worktree'];
  additionalDirs: readonly string[];
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  agentProfile?: string;
  agentFiles?: readonly string[];
  inputMode: 'prompt' | 'bash';
  swarmMode: boolean;
  towerMode: boolean;
  loopLifecycleEvents?: boolean;
  thinkingEffort: ThinkingEffort;
  configDefaultPlanMode?: boolean;
  lazySessionThinking?: ThinkingEffort;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  cumulativeTokens?: number;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  streamingStartTime: number;
  stepRetry: StepRetryState | null;
  theme: ThemeName;
  tuiMode?: TuiMode;
  version: string;
  editorCommand: string | null;
  disablePasteBurst?: boolean;
  selectionCopyMode?: SelectionCopyMode;
  mouse?: MouseConfig;
  renderLatex?: boolean;
  cacheExpiryHint?: boolean;
  disableFeedbackSurvey?: boolean;
  autoSessionTitle?: boolean;
  followUpBehavior?: FollowUpBehavior;
  notifications: NotificationsConfig;
  upgrade: UpgradePreferences;
  statusLine?: StatusLineConfig;
  markdown?: MarkdownConfig;
  transcript: TranscriptConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
  banner?: BannerState | null;
  environment?: EnvironmentSlotState;
}

export function sumTokenUsage(total: TokenUsage): number | undefined {
  if (total.inputCacheRead === undefined) return undefined;
  return total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation;
}

export interface StepRetryState {
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  errorName: string;
  errorMessage: string;
  statusCode?: number;
  phase: 'backoff' | 'attempt';
}

export type Elapsed =
  | { readonly known: false }
  | { readonly known: true; readonly ms: number };

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
  readonly taskId?: string;
  readonly model?: string;
  readonly effort?: string;
}

export type BackgroundAgentStatusPhase = 'started' | 'completed' | 'failed' | 'killed';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly agentId?: string;
}

export interface CompactionTranscriptData {
  readonly result?: 'cancelled';
  readonly summary?: string;
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

export type GoalTranscriptData =
  | { readonly kind: 'created' }
  | { readonly kind: 'lifecycle'; readonly change: GoalChange };

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'plugin_command'
  | 'cron'
  | 'goal';

export type SkillActivationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface PluginCommandTranscriptData {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string;
  readonly trigger: 'user-slash';
}

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  bullet?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  goalData?: GoalTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillNames?: readonly string[];
  inlineSkillActivations?: readonly InlineSkillActivation[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  bundledWithPrompt?: boolean;
  hookResult?: boolean;
  pluginCommandData?: PluginCommandTranscriptData;
  steerPending?: true;
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

export interface PreparedSkillActivations {
  skills: Array<{ name: string; path?: string; args?: string }>;
  mediaAttachmentIds: number[];
  stagingPaths: string[];
  cachedVideos: VideoAttachment[];
}

export interface InlineSkillActivation {
  readonly skillName: string;
  readonly path?: string;
  readonly args?: string;
  readonly start?: number;
  readonly occurrences?: readonly { commandName: string; start: number }[];
}

export type ModelSwitchPersistence = 'session' | 'model' | 'model-and-effort';

interface QueuedEntryBase {
  readonly text: string;
}

export interface QueuedPromptMessage extends QueuedEntryBase {
  readonly mode?: 'prompt';
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly mediaSnapshots?: readonly MediaAttachment[];
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
  readonly occupiedRetry?: boolean;
  readonly holdUntilTurnEnds?: boolean;
}

export interface QueuedBashCommand extends QueuedEntryBase {
  readonly mode: 'bash';
  readonly agentId?: string;
}

export interface QueuedCompactCommand extends QueuedEntryBase {
  readonly mode: 'compact';
  readonly agentId?: string;
  readonly compactInstruction?: string;
  readonly compactRetries?: number;
  readonly queuedAfterAutoSerial?: number;
}

export interface QueuedModelSwitch extends QueuedEntryBase {
  readonly mode: 'model-switch';
  readonly alias: string;
  readonly thinking: ThinkingEffort;
  readonly persist: ModelSwitchPersistence;
  readonly queuedAfterCompactionSerial: number;
}

export type QueuedMessage =
  | QueuedPromptMessage
  | QueuedBashCommand
  | QueuedCompactCommand
  | QueuedModelSwitch;

export function isPromptQueuedMessage(message: QueuedMessage): message is QueuedPromptMessage {
  return message.mode === undefined || message.mode === 'prompt';
}

export function isQueuedCompactionBarrier(message: QueuedMessage): boolean {
  return message.mode === 'compact' || message.mode === 'model-switch';
}

export type SteerOutcome = 'steered' | 'failed' | 'restored';

export interface SteerInputItem {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly mediaSnapshots?: readonly MediaAttachment[];
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
};

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  readonly additionalDirs?: readonly string[];
  readonly agentProfile?: string;
  readonly agentFiles?: readonly string[];
  readonly environment?: string;
  readonly environmentCwd?: string;
  readonly worktree?: { readonly name: string; readonly base?: string };
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
  resolvedTuiMode?: TuiMode;
  animationFrameRate?: number;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
