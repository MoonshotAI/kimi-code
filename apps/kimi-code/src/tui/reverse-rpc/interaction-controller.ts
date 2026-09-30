import {
  InteractionRef,
  interaction as interactionFeature,
  isInteractionCancellation,
  type Interaction,
  type Interactions,
} from '@moonshot-ai/harness-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';

import {
  adaptApprovalPayload,
  adaptPanelResponse,
  isGoalStartPayload,
  isPermissionApprovalPayload,
  isPlanReviewPayload,
  type GoalStartPayload,
  type PermissionApprovalPayload,
  type PlanReviewPayload,
} from './approval/adapter';
import {
  adaptQuestionAnswers,
  adaptQuestionPayload,
  type QuestionInteractionPayload,
} from './question/adapter';
import type { ApprovalPanelData, QuestionPanelData, QuestionPanelResponse } from './types';

export interface InteractionUIHooks {
  showApprovalPanel(payload: ApprovalPanelData): void;
  hideApprovalPanel(): void;
  showQuestionDialog(payload: QuestionPanelData): void;
  hideQuestionDialog(): void;
  onApprovalResolved(payload: ApprovalPanelData, response: ApprovalPanelResponse): void;
}

type PendingInteraction =
  | {
      readonly kind: 'approval';
      readonly interaction: Interaction;
      readonly payload: PermissionApprovalPayload | PlanReviewPayload | GoalStartPayload;
    }
  | {
      readonly kind: 'question';
      readonly interaction: Interaction;
      readonly payload: QuestionInteractionPayload;
    };

function classify(interaction: Interaction): PendingInteraction | undefined {
  if (interaction.kind === 'approval') {
    const payload = interaction.payload;
    if (
      !isPermissionApprovalPayload(payload) &&
      !isPlanReviewPayload(payload) &&
      !isGoalStartPayload(payload)
    ) {
      return undefined;
    }
    return { kind: 'approval', interaction, payload };
  }
  if (interaction.kind === 'question') {
    const payload = interaction.payload as QuestionInteractionPayload;
    if (!Array.isArray(payload?.questions)) return undefined;
    return { kind: 'question', interaction, payload };
  }
  return undefined;
}

/**
 * Bridges harness-core interactions (permission approvals, plan reviews,
 * AskUserQuestion) to the TUI panels: subscribes `interaction.requested`,
 * shows one panel at a time (further requests queue behind it), and routes
 * the user's choice back through `interactions.respond`. Engine-side
 * cancellations (turn ended / agent closed) dismiss the affected panel.
 */
export class InteractionController {
  private interactions: Interactions | undefined;
  private unsubscribe: (() => void) | undefined;
  private current: PendingInteraction | null = null;
  private queue: PendingInteraction[] = [];

  constructor(private readonly hooks: InteractionUIHooks) {}

  mountSession(session: KimiSession): void {
    this.unmountSession();
    const interactions = session.handle.resolve(InteractionRef);
    if (interactions === undefined) return;
    this.interactions = interactions;
    const offRequested = session.handle.on(
      interactionFeature,
      'interaction.requested',
      (event) => {
        this.enqueue(event.interaction);
      },
    );
    const offResolved = session.handle.on(
      interactionFeature,
      'interaction.resolved',
      (event) => {
        if (!isInteractionCancellation(event.response)) return;
        if (this.current?.interaction.id !== event.id) return;
        this.dismissCurrent();
      },
    );
    this.unsubscribe = () => {
      offRequested();
      offResolved();
    };
    // Late subscriber: catch requests fired before the subscription landed.
    for (const item of interactions.findAll({ resolved: false })) {
      this.enqueue(item);
    }
  }

  unmountSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.interactions = undefined;
    this.queue = [];
    if (this.current !== null) {
      const current = this.current;
      this.current = null;
      this.hidePanel(current);
    }
  }

  respondApproval(response: ApprovalPanelResponse): void {
    const current = this.current;
    if (current?.kind !== 'approval') return;
    this.current = null;
    this.interactions?.respond(current.interaction.id, adaptPanelResponse(response));
    this.hooks.onApprovalResolved(adaptApprovalPayload(current.interaction.id, current.payload), response);
    this.advanceOrHide(current);
  }

  respondQuestion(response: QuestionPanelResponse): void {
    const current = this.current;
    if (current?.kind !== 'question') return;
    this.current = null;
    this.interactions?.respond(
      current.interaction.id,
      adaptQuestionAnswers(current.payload, response),
    );
    this.advanceOrHide(current);
  }

  hasPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private enqueue(interaction: Interaction): void {
    const pending = classify(interaction);
    if (pending === undefined) {
      // An interaction kind the TUI cannot render (e.g. user_tool): never
      // leave the engine waiter hanging — answer it with an empty response.
      this.interactions?.respond(interaction.id, { answers: {} });
      return;
    }
    if (this.current === null) {
      this.current = pending;
      this.showPanel(pending);
      return;
    }
    this.queue.push(pending);
  }

  private dismissCurrent(): void {
    const current = this.current;
    if (current === null) return;
    this.current = null;
    this.advanceOrHide(current);
  }

  private advanceOrHide(closed: PendingInteraction): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.hidePanel(closed);
      return;
    }
    this.hidePanel(closed);
    this.current = next;
    this.showPanel(next);
  }

  private showPanel(pending: PendingInteraction): void {
    if (pending.kind === 'approval') {
      this.hooks.showApprovalPanel(
        adaptApprovalPayload(pending.interaction.id, pending.payload),
      );
      return;
    }
    this.hooks.showQuestionDialog(
      adaptQuestionPayload(pending.interaction.id, pending.payload),
    );
  }

  private hidePanel(pending: PendingInteraction): void {
    if (pending.kind === 'approval') {
      this.hooks.hideApprovalPanel();
      return;
    }
    this.hooks.hideQuestionDialog();
  }
}
