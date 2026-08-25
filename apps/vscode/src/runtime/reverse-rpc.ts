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
  private readonly approvals = new Map<
    string,
    { resolve: (response: CoreApprovalResponse) => void; flowGate: boolean }
  >();
  private readonly questions = new Map<string, (result: QuestionResult) => void>();

  constructor(private readonly emit: (event: ReverseRpcEvent) => void) {}

  requestApproval(request: ApprovalRequest): Promise<CoreApprovalResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.approvals.set(id, {
        resolve,
        flowGate:
          request.display?.kind === "flow_start_review" ||
          request.display?.kind === "flow_gate_review" ||
          request.display?.kind === "flow_jump_review",
      });
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
    const pending = this.approvals.get(id);
    if (!pending) return false;
    this.approvals.delete(id);
    if (response === "approve_for_session") {
      // A flow gate never installs a session rule: the engine re-asks every
      // human gate regardless, so a session-scope answer degrades to a
      // one-shot approval instead of recording a rule it will not honor.
      pending.resolve(
        pending.flowGate ? { decision: "approved" } : { decision: "approved", scope: "session" },
      );
    } else if (response === "approve") {
      pending.resolve({ decision: "approved" });
    } else if (pending.flowGate) {
      // The label proves a user actually clicked No — flow-gate provenance
      // treats a bare rejection as an unobserved transport failure and
      // refuses to record it as a human verdict. Other tools keep the bare
      // rejection shape their consumers expect.
      pending.resolve({ decision: "rejected", selectedLabel: "Reject" });
    } else {
      pending.resolve({ decision: "rejected" });
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
    for (const pending of this.approvals.values()) {
      pending.resolve({ decision: "cancelled", feedback: reason });
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
