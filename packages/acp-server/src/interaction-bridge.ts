import type {
  Interaction,
  QuestionAnswers,
  QuestionRequest,
  SessionApprovalRequest as ApprovalRequest,
  SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';
import type { IDisposable, SessionHandle } from '@moonshot-ai/klient';

import type { AcpClient } from './acp-client';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import { acpToolCallId } from './events-map';
import { log } from './log';
import {
  elicitationResponseToQuestionAnswers,
  outcomeToQuestionAnswer,
  questionItemToPermissionOptions,
  questionRequestToElicitationParams,
} from './question';

export class AcpInteractionBridge {
  private readonly inFlight = new Set<string>();
  private readonly subscription: IDisposable;
  private disposed = false;

  constructor(
    private readonly conn: AcpClient,
    private readonly session: SessionHandle,
    private readonly sessionId: string,
    private readonly elicitationForm = false,
  ) {
    this.subscription = session.events.on('interactions.changed', (pending) => {
      this.onPendingChanged(pending);
    });
    void this.session.interactions.list().then(
      (pending) => {
        this.onPendingChanged(pending);
      },
      (error: unknown) => {
        log.warn('acp: initial interaction sweep failed', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.inFlight.clear();
  }

  private onPendingChanged(pending: readonly Interaction[]): void {
    if (this.disposed) return;
    for (const interaction of pending) {
      if (this.inFlight.has(interaction.id)) continue;
      if (interaction.kind !== 'approval' && interaction.kind !== 'question') continue;
      this.inFlight.add(interaction.id);
      void this.dispatch(interaction);
    }
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    const respond = (response: unknown): Promise<void> =>
      this.session.interactions.respond(interaction.id, response);
    try {
      if (interaction.kind === 'approval') {
        const response = await this.handleApproval(interaction.payload as ApprovalRequest);
        await respond(response);
        return;
      }
      if (interaction.kind === 'question') {
        const result = await this.handleQuestion(interaction.payload as QuestionRequest);
        await respond(result);
      }
    } catch (error) {
      log.warn('acp: interaction bridge dispatch failed', {
        sessionId: this.sessionId,
        interactionId: interaction.id,
        kind: interaction.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback: unknown =
        interaction.kind === 'approval'
          ? ({ decision: 'rejected' } satisfies ApprovalResponse)
          : null;
      await respond(fallback).catch((respondError: unknown) => {
        log.warn('acp: interaction bridge fallback respond failed', {
          sessionId: this.sessionId,
          interactionId: interaction.id,
          error: respondError instanceof Error ? respondError.message : String(respondError),
        });
      });
    }
  }

  private async handleApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    const toolCall = buildPermissionToolCallUpdate(req);
    const options = approvalRequestToPermissionOptions(req);
    try {
      const response = await this.conn.requestPermission({
        sessionId: this.sessionId,
        options: [...options],
        toolCall,
      });
      return attachSelectedLabel(
        response,
        permissionResponseToApprovalResponse(req, response),
        options,
      );
    } catch (error) {
      log.warn('acp: requestPermission failed; rejecting', {
        sessionId: this.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { decision: 'rejected' };
    }
  }

  private async handleQuestion(req: QuestionRequest): Promise<QuestionAnswers | null> {
    const questions = req.questions;
    if (questions.length === 0) {
      log.warn('acp: handleQuestion received empty questions array', {
        sessionId: this.sessionId,
      });
      return null;
    }
    const rawToolCallId = req.toolCallId ?? 'ask-user';
    const toolCallId =
      req.turnId !== undefined ? acpToolCallId(req.turnId, rawToolCallId) : rawToolCallId;
    if (this.elicitationForm) {
      try {
        const response = await this.conn.createElicitation(
          questionRequestToElicitationParams(questions, this.sessionId, toolCallId),
        );
        return elicitationResponseToQuestionAnswers(questions, response);
      } catch (error) {
        log.warn('acp: elicitation/create failed; falling back to request_permission', {
          sessionId: this.sessionId,
          toolCallId: req.toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (questions.length > 1) {
      log.warn('acp: handleQuestion degrading to first question only', {
        sessionId: this.sessionId,
        dropped: questions.length - 1,
      });
    }
    const q = questions[0]!;
    const options = questionItemToPermissionOptions(q, 0);
    try {
      const response = await this.conn.requestPermission({
        sessionId: this.sessionId,
        options: [...options],
        toolCall: {
          toolCallId,
          title: 'AskUserQuestion',
          content: [{ type: 'content', content: { type: 'text', text: q.question } }],
        },
      });
      return outcomeToQuestionAnswer(q, response);
    } catch (error) {
      log.warn('acp: requestPermission (question) failed; dismissing', {
        sessionId: this.sessionId,
        toolCallId: req.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
