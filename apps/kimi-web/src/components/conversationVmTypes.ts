// apps/kimi-web/src/components/conversationVmTypes.ts
// View-model and actions aggregates for ConversationPane. These mirror the
// component's previous individual props one-for-one so the refactor is purely
// structural (no type or behavior changes).
import type { ActivationBadges, ApprovalBlock, ChatTurn, ConversationStatus, QueuedPromptView, TaskItem, TodoView, UIQuestion, WorkspaceView } from '../types';
import type { AppGoal, AppModel, AppSkill, ThinkingLevel } from '../api/types';
import type { SwarmGroup } from '../composables/swarmGroups';
import type { FileItem } from './MentionMenu.vue';

export interface ConversationVm {
  turns: ChatTurn[];
  sessionId?: string;
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  tasks: TaskItem[];
  /** Model-maintained todo list (TodoList tool) — shown as a floating card. */
  todos?: TodoView[];
  goal?: AppGoal | null;
  swarms?: SwarmGroup[];
  activationBadges?: ActivationBadges;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  questions?: UIQuestion[];
  running?: boolean;
  queued?: QueuedPromptView[];
  /** Git changed files (only used for the header diff counter dot). */
  changes?: { path: string; status: string }[];
  /** Cache-buster that remounts the chat pane when the active session changes. */
  fileReloadKey?: string | number;
  sending?: boolean;
  fastMoon?: boolean;
  /** Mobile shell: compact chrome. */
  mobile?: boolean;
  /** Bubble themes (Modern/Kimi): render chat bubbles at all widths (desktop included). */
  modern?: boolean;
  /** True while switching sessions and the turns array is not yet loaded. */
  sessionLoading?: boolean;
  /** Live compaction state of the active session (non-null while running). */
  compaction?: { status: 'running' } | null;
  /** Whether there are older messages available to load when scrolling up. */
  hasMoreMessages?: boolean;
  /** True while older messages are being fetched (scroll-up lazy load). */
  loadingMore?: boolean;
  /** True when the last older-message fetch failed; blocks sentinel auto-retry. */
  loadingMoreError?: boolean;
  /** Available models for the quick-switch dropdown in the composer toolbar. */
  models?: AppModel[];
  /** Starred model ids shown at the top of the composer's quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the composer `/` menu. */
  skills?: AppSkill[];
  /** Workspace name shown in the empty-session hint above the centred composer. */
  workspaceName?: string;
  /** Absolute workspace root path. */
  workspaceRoot?: string;
  /** Git diff line stats for the header diff counter (mirrors kimi-cli/web). */
  gitDiffStats?: { totalAdditions: number; totalDeletions: number } | null;
  /** Workspaces for the empty-composer picker (start a conversation elsewhere). */
  workspaces?: WorkspaceView[];
  /** Active workspace id, to highlight the current entry in the picker. */
  activeWorkspaceId?: string | null;
  /** Active session title, shown in the chat header. */
  sessionTitle?: string;
  /** GitHub PR for the current branch, when known (shown in the chat header). */
  pr?: { number: number; state: string; url: string } | null;
  /** Beta conversation outline: proportional bubbles, viewport indicator, hover tooltip. */
  betaToc?: boolean;
}

export interface ConversationActions {
  searchFiles: (q: string) => Promise<FileItem[]>;
  uploadImage: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  loadOlderMessages: (sessionId: string) => Promise<void>;
}
