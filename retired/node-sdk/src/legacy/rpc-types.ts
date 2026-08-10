// Frozen local copies of the SDK reverse-RPC request/response types.
//
// These are the camelCase shapes hosts (kimi-code TUI, vscode) still use for
// engine reverse-RPC callbacks (approval panels, questions, tool-call display).
// They were defined in the now-retired agent-core; this local copy keeps the
// host-facing SDK surface intact while agent-core is unbundled.
//
// NOTE (2026-08-02): the Rust engine's canonical approval payload differs
// (snake_case ApprovalEntry: id/session_id/tool_call_id/arguments/approval_rule/
// created_at_ms; resolved via session/approval_list + approval_resolve). Hosts
// map through adapters today. TODO(engine-alignment): regenerate these types
// from the Rust reverse-RPC payload so this local copy can be deleted.
//
// ToolInputDisplay is shared via @moonshot-ai/protocol.
import type { ContentPart } from '@moonshot-ai/kosong';

import type { ToolInputDisplay } from '@moonshot-ai/protocol';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
export type ApprovalScope = 'session';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';
/**
 * Flattened answers keyed by question text; values are the chosen option
 * label(s) (comma-joined for multi-select) or free-form "Other" text.
 * `true` marks a question as answered without echoing a concrete value.
 */
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}
