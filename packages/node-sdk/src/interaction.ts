import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { QuestionRequest as CoreQuestionRequest } from '@moonshot-ai/agent-core-v2/agent/interaction/question';

export type {
  ApprovalDecision,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/agent/interaction/approval';
export type {
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/agent/interaction/question';

export type ApprovalScope = 'session';

export interface ApprovalRequest {
  readonly agentId?: string;
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface QuestionRequest extends CoreQuestionRequest {
  readonly agentId?: string;
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
