import { randomUUID } from "node:crypto";

import type {
  ApprovalRequest,
  ApprovalResponse as CoreApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from "@moonshot-ai/kimi-code-sdk";

import type { ApprovalResponse, QuestionRequest as LegacyQuestionRequest } from "../../shared/legacy-sdk";
import { describeToolDisplay, toLegacyDisplay } from "./tool-display";

export type ReverseRpcEvent =
  | { type: "ApprovalRequest"; payload: ReturnType<typeof approvalPayload> }
  | { type: "QuestionRequest"; payload: LegacyQuestionRequest };

export class ReverseRpcController {
  private readonly approvals = new Map<string, (response: CoreApprovalResponse) => void>();
  private readonly questions = new Map<string, (result: QuestionResult) => void>();

  constructor(private readonly emit: (event: ReverseRpcEvent) => void) {}

  requestApproval(request: ApprovalRequest): Promise<CoreApprovalResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.approvals.set(id, resolve);
      this.emit({ type: "ApprovalRequest", payload: approvalPayload(id, request) });
    });
  }

  requestQuestion(request: QuestionRequest): Promise<QuestionResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.questions.set(id, resolve);
      this.emit({
        type: "QuestionRequest",
        payload: {
          id,
          tool_call_id: request.toolCallId ?? "",
          questions: request.questions.map((question) => ({
            question: question.question,
            header: question.header,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description,
            })),
            multi_select: question.multiSelect,
          })),
        },
      });
    });
  }

  respondApproval(id: string, response: ApprovalResponse): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    if (response === "approve_for_session") {
      resolve({ decision: "approved", scope: "session" });
    } else if (response === "approve") {
      resolve({ decision: "approved" });
    } else {
      resolve({ decision: "rejected" });
    }
    return true;
  }

  respondQuestion(id: string, answers: Record<string, string>): boolean {
    const resolve = this.questions.get(id);
    if (!resolve) return false;
    this.questions.delete(id);
    resolve({ answers });
    return true;
  }

  cancelAll(reason: string): void {
    for (const resolve of this.approvals.values()) {
      resolve({ decision: "cancelled", feedback: reason });
    }
    for (const resolve of this.questions.values()) {
      resolve(null);
    }
    this.approvals.clear();
    this.questions.clear();
  }
}

function approvalPayload(id: string, request: ApprovalRequest) {
  return {
    id,
    tool_call_id: request.toolCallId,
    sender: request.toolName,
    action: request.action,
    description: describeToolDisplay(request.display),
    display: toLegacyDisplay(request.display),
  };
}
