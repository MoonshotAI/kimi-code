import {
  INTERACTION_TAG_TOOL_CALL_ID,
  InteractionRef,
  interaction as interactionFeature,
  isInteractionCancellation,
  type Interaction,
  type Interactions,
} from "@moonshot-ai/harness-core";
import type { KimiSession } from "@moonshot-ai/kimi-code-sdk";

import type {
  ApprovalResponse,
  DisplayBlock,
  QuestionRequest as LegacyQuestionRequest,
} from "../../shared/legacy-sdk";
import { deriveToolDisplay, describeToolCall } from "./tool-display";

export type ReverseRpcEvent =
  | { type: "ApprovalRequest"; payload: ApprovalRequestPayload }
  | { type: "QuestionRequest"; payload: LegacyQuestionRequest };

interface ApprovalRequestPayload {
  id: string;
  tool_call_id: string;
  sender: string;
  action: string;
  description: string;
  display?: DisplayBlock[];
}

interface PermissionApprovalPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly toolInput?: unknown;
}

interface PlanReviewPayload {
  readonly plan: string;
  readonly path: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
}

interface GoalStartPayload {
  readonly kind: "goal_start";
  readonly objective?: string;
  readonly completionCriterion?: string;
}

interface QuestionInteractionPayload {
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
    readonly multi_select: boolean;
  }[];
}

type PendingKind = "approval" | "question";

export class ReverseRpcController {
  private interactions: Interactions | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly pending = new Map<string, PendingKind>();

  constructor(private readonly emit: (event: ReverseRpcEvent) => void) {}

  mountSession(session: KimiSession): void {
    this.unmountSession();
    const interactions = session.handle.resolve(InteractionRef);
    if (interactions === undefined) return;
    this.interactions = interactions;
    const offRequested = session.handle.on(
      interactionFeature,
      "interaction.requested",
      (event) => {
        this.forward(event.interaction);
      },
    );
    const offResolved = session.handle.on(
      interactionFeature,
      "interaction.resolved",
      (event) => {
        if (isInteractionCancellation(event.response)) this.pending.delete(event.id);
      },
    );
    this.unsubscribe = () => {
      offRequested();
      offResolved();
    };
    for (const item of interactions.findAll({ resolved: false })) {
      this.forward(item);
    }
  }

  unmountSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.interactions = undefined;
    this.pending.clear();
  }

  respondApproval(id: string, response: ApprovalResponse): boolean {
    if (this.pending.get(id) !== "approval") return false;
    this.pending.delete(id);
    if (response === "approve_for_session") {
      return this.interactions?.respond(id, { decision: "approved", scope: "session" }) ?? false;
    }
    if (response === "approve") {
      return this.interactions?.respond(id, { decision: "approved" }) ?? false;
    }
    return this.interactions?.respond(id, { decision: "rejected" }) ?? false;
  }

  respondQuestion(id: string, answers: Record<string, string>): boolean {
    if (this.pending.get(id) !== "question") return false;
    this.pending.delete(id);
    return this.interactions?.respond(id, { answers }) ?? false;
  }

  cancelAll(reason: string): void {
    if (this.interactions === undefined) {
      this.pending.clear();
      return;
    }
    for (const [id, kind] of [...this.pending]) {
      this.pending.delete(id);
      if (kind === "approval") {
        this.interactions.respond(id, { decision: "cancelled", feedback: reason });
      } else {
        this.interactions.respond(id, { cancelled: true, reason: "turn_ended" });
      }
    }
  }

  private forward(interaction: Interaction): void {
    if (this.pending.has(interaction.id)) return;
    if (interaction.kind === "approval") {
      const payload = approvalPayload(interaction);
      if (payload === undefined) {
        this.interactions?.respond(interaction.id, { decision: "cancelled" });
        return;
      }
      this.pending.set(interaction.id, "approval");
      this.emit({ type: "ApprovalRequest", payload });
      return;
    }
    if (interaction.kind === "question") {
      const payload = questionPayload(interaction);
      if (payload === undefined) {
        this.interactions?.respond(interaction.id, { answers: {} });
        return;
      }
      this.pending.set(interaction.id, "question");
      this.emit({ type: "QuestionRequest", payload });
      return;
    }
    this.interactions?.respond(interaction.id, { answers: {} });
  }
}

function approvalPayload(interaction: Interaction): ApprovalRequestPayload | undefined {
  const payload = interaction.payload;
  if (isPermissionApprovalPayload(payload)) {
    const display = deriveToolDisplay(payload.toolName, payload.toolInput);
    return {
      id: interaction.id,
      tool_call_id: payload.toolCallId,
      sender: payload.toolName,
      action: payload.action,
      description: describeToolCall(payload.toolName, payload.toolInput),
      display,
    };
  }
  if (isPlanReviewPayload(payload)) {
    return {
      id: interaction.id,
      tool_call_id: interaction.id,
      sender: "ExitPlanMode",
      action: "Approve plan",
      description: "",
      display: payload.plan.trim().length > 0 ? [{ type: "brief", text: payload.plan }] : [],
    };
  }
  if (isGoalStartPayload(payload)) {
    const lines = [`Start goal: ${payload.objective ?? ""}`];
    if (payload.completionCriterion !== undefined && payload.completionCriterion.length > 0) {
      lines.push(`Done when: ${payload.completionCriterion}`);
    }
    return {
      id: interaction.id,
      tool_call_id: interaction.id,
      sender: "CreateGoal",
      action: "Start a goal?",
      description: "",
      display: [{ type: "brief", text: lines.join("\n") }],
    };
  }
  return undefined;
}

function questionPayload(interaction: Interaction): LegacyQuestionRequest | undefined {
  const payload = interaction.payload as QuestionInteractionPayload | undefined;
  if (!payload?.questions.every((question) => typeof question.question === "string")) {
    return undefined;
  }
  const toolCallId = interaction.tags[INTERACTION_TAG_TOOL_CALL_ID];
  return {
    id: interaction.id,
    tool_call_id: typeof toolCallId === "string" ? toolCallId : "",
    questions: payload.questions.map((question) => ({
      question: question.question,
      header: question.header.length > 0 ? question.header : undefined,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description.length > 0 ? option.description : undefined,
      })),
      multi_select: question.multi_select,
    })),
  };
}

function isPermissionApprovalPayload(payload: unknown): payload is PermissionApprovalPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { toolName?: unknown }).toolName === "string" &&
    typeof (payload as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isPlanReviewPayload(payload: unknown): payload is PlanReviewPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { plan?: unknown }).plan === "string" &&
    typeof (payload as { path?: unknown }).path === "string"
  );
}

function isGoalStartPayload(payload: unknown): payload is GoalStartPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "goal_start"
  );
}
