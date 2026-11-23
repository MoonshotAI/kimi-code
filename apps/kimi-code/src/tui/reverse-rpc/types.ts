import type { QuestionAnswerMethod } from '@moonshot-ai/kimi-code-sdk';

export interface BriefDisplayBlock {
  type: 'brief';
  text: string;
}

export interface ReviewDisplayBlock {
  type: 'review';
  title: string;
  detail: string;
}

export interface DiffDisplayBlock {
  type: 'diff';
  path: string;
  old_text: string;
  new_text: string;
  old_start?: number | undefined;
  new_start?: number | undefined;
  is_summary?: boolean | undefined;
}

export interface ShellDisplayBlock {
  type: 'shell';
  language: string;
  command: string;
  cwd?: string | undefined;
  description?: string | undefined;
  danger?: string | undefined;
}

export interface FileOpDisplayBlock {
  type: 'file_op';
  operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
  path: string;
  detail?: string | undefined;
}

export interface FileContentDisplayBlock {
  type: 'file_content';
  path: string;
  content: string;
  language?: string | undefined;
}

export interface UrlFetchDisplayBlock {
  type: 'url_fetch';
  url: string;
  method?: string | undefined;
}

export interface SearchDisplayBlock {
  type: 'search';
  query: string;
  scope?: string | undefined;
}

export interface InvocationDisplayBlock {
  type: 'invocation';
  kind: 'agent' | 'skill';
  name: string;
  description?: string | undefined;
}

export interface TodoDisplayItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface TodoDisplayBlock {
  type: 'todo';
  items: TodoDisplayItem[];
}

export interface BackgroundTaskDisplayBlock {
  type: 'background_task';
  task_id: string;
  kind: string;
  status: string;
  description: string;
}

export type DisplayBlock =
  | BriefDisplayBlock
  | ReviewDisplayBlock
  | DiffDisplayBlock
  | ShellDisplayBlock
  | FileOpDisplayBlock
  | FileContentDisplayBlock
  | UrlFetchDisplayBlock
  | SearchDisplayBlock
  | InvocationDisplayBlock
  | TodoDisplayBlock
  | BackgroundTaskDisplayBlock;

export interface ApprovalPanelChoice {
  label: string;
  response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  selected_label?: string | undefined;
  requires_feedback?: boolean | undefined;
  description?: string | undefined;
}

export interface ApprovalPanelData {
  id: string;
  tool_call_id: string;
  tool_name: string;
  action: string;
  description: string;
  display: DisplayBlock[];
  choices: ApprovalPanelChoice[];
  environment?: string;
}

export interface QuestionPanelItem {
  question: string;
  header?: string;
  body?: string;
  multi_select: boolean;
  other_label?: string;
  other_description?: string;
  options: Array<{ label: string; description?: string }>;
}

export interface QuestionPanelData {
  id: string;
  tool_call_id: string;
  questions: QuestionPanelItem[];
}

export type QuestionSubmissionMethod = QuestionAnswerMethod;

export interface QuestionPanelResponse {
  readonly answers: string[];
  readonly method?: QuestionSubmissionMethod | undefined;
}

export interface PendingApproval {
  data: ApprovalPanelData;
}

export interface PendingQuestion {
  data: QuestionPanelData;
}
