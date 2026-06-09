export type DisplayRole = 'user' | 'assistant' | 'system';
export type DisplayMessageStatus = 'streaming' | 'completed' | 'interrupted' | 'error';
export type DisplayToolStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';
export type DisplayTodoStatus = 'pending' | 'in_progress' | 'done';
export type DisplayMediaKind = 'image' | 'audio' | 'video';
export type DisplayCompactionTrigger = 'manual' | 'auto';

export interface DisplayTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

export interface DisplayStatusViewModel {
  contextUsage?: number | null;
  contextTokens?: number | null;
  maxContextTokens?: number | null;
  tokenUsage?: DisplayTokenUsage | null;
  messageId?: string | null;
}

export interface DisplayPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
}

export interface DisplayAvailableCommand {
  name: string;
  description: string;
  group?: string;
}

export type DisplayErrorPhase = 'preflight' | 'runtime';

export interface DisplayErrorModel {
  code: string;
  message: string;
  phase: DisplayErrorPhase;
  details?: Record<string, unknown>;
}

export interface DisplayPlanViewModel {
  entries: DisplayPlanEntry[];
}

export interface DisplayBriefBlock {
  type: 'brief';
  text: string;
}

export interface DisplayDiffBlock {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
}

export interface DisplayTodoItem {
  title: string;
  status: DisplayTodoStatus;
}

export interface DisplayTodoBlock {
  type: 'todo';
  items: DisplayTodoItem[];
}

export interface DisplayCommandBlock {
  type: 'command';
  language: string;
  command: string;
  cwd?: string;
  description?: string;
  danger?: string;
}

export type DisplayFileOperation = 'read' | 'write' | 'edit' | 'glob' | 'grep';

export interface DisplayFileOperationBlock {
  type: 'file-op';
  operation: DisplayFileOperation;
  path: string;
  detail?: string;
}

export interface DisplayFileContentBlock {
  type: 'file-content';
  path: string;
  content: string;
  language?: string;
}

export interface DisplayUrlFetchBlock {
  type: 'url-fetch';
  url: string;
  method?: string;
}

export interface DisplaySearchBlock {
  type: 'search';
  query: string;
  scope?: string;
}

export type DisplayInvocationKind = 'agent' | 'skill';

export interface DisplayInvocationBlock {
  type: 'invocation';
  kind: DisplayInvocationKind;
  name: string;
  description?: string;
}

export interface DisplayBackgroundTaskBlock {
  type: 'background-task';
  taskId: string;
  kind: string;
  status: string;
  description?: string;
}

export type DisplayBlock =
  | DisplayBriefBlock
  | DisplayDiffBlock
  | DisplayTodoBlock
  | DisplayCommandBlock
  | DisplayFileOperationBlock
  | DisplayFileContentBlock
  | DisplayUrlFetchBlock
  | DisplaySearchBlock
  | DisplayInvocationBlock
  | DisplayBackgroundTaskBlock;

export interface DisplayTextPart {
  type: 'text';
  text: string;
  finished?: boolean;
}

export interface DisplayThinkingPart {
  type: 'thinking';
  text: string;
  finished?: boolean;
}

export interface DisplayMediaPart {
  type: 'media';
  kind: DisplayMediaKind;
  url: string;
  id?: string | null;
}

export interface DisplayToolCallPart {
  type: 'tool-call';
  id: string;
  name: string;
  argumentsText?: string | null;
  status: DisplayToolStatus;
  resultText?: string;
  displayBlocks?: DisplayBlock[];
  children?: DisplayStep[];
}

export interface DisplayPlanPart {
  type: 'plan';
  plan: DisplayPlanViewModel;
}

export interface DisplayCompactionPart {
  type: 'compaction';
  status: 'running' | 'completed' | 'cancelled' | 'blocked';
  trigger?: DisplayCompactionTrigger;
  instruction?: string;
  summary?: string;
  compactedCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  message?: string;
}

export interface DisplayErrorPart {
  type: 'error';
  error: DisplayErrorModel;
}

export interface DisplayApprovalOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface DisplayApprovalPart {
  type: 'approval';
  requestId: string | number;
  toolCallId: string;
  sender: string;
  action: string;
  description: string;
  displayBlocks?: DisplayBlock[];
  options?: DisplayApprovalOption[];
}

export interface DisplayStatusPart {
  type: 'status';
  status: DisplayStatusViewModel;
}

export interface DisplayInterruptPart {
  type: 'interrupt';
  reason?: string;
  message?: string;
}

export type DisplayPart =
  | DisplayTextPart
  | DisplayThinkingPart
  | DisplayMediaPart
  | DisplayToolCallPart
  | DisplayPlanPart
  | DisplayCompactionPart
  | DisplayErrorPart
  | DisplayApprovalPart
  | DisplayStatusPart
  | DisplayInterruptPart;

export interface DisplayStep {
  id: string;
  n: number;
  parts: DisplayPart[];
}

export interface DisplayMessage {
  id: string;
  role: DisplayRole;
  parts: DisplayPart[];
  steps?: DisplayStep[];
  status?: DisplayMessageStatus;
  createdAt?: number;
}

export interface DisplayState {
  messages: DisplayMessage[];
  plan: DisplayPlanViewModel | null;
  status: DisplayStatusViewModel | null;
  pendingApprovals: DisplayApprovalPart[];
  tokenUsage: DisplayTokenUsage;
  activeTokenUsage: DisplayTokenUsage;
  availableCommands: DisplayAvailableCommand[];
  isStreaming: boolean;
  isCompacting: boolean;
}

export function createEmptyTokenUsage(): DisplayTokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

export function createInitialDisplayState(): DisplayState {
  return {
    messages: [],
    plan: null,
    status: null,
    pendingApprovals: [],
    tokenUsage: createEmptyTokenUsage(),
    activeTokenUsage: createEmptyTokenUsage(),
    availableCommands: [],
    isStreaming: false,
    isCompacting: false,
  };
}
