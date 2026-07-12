/**
 * ACP interaction bridge — forwards the engine's blocking human-in-the-loop
 * requests (approval + ask-user) to the ACP client via
 * `session/request_permission`, and relays the client's decision back to the
 * `interaction` kernel.
 *
 * The engine's `AgentPermissionGate` and `AskUserQuestionTool` park requests on
 * the Session-scoped `ISessionInteractionService` and block on their response.
 * This bridge is a pure edge observer: it subscribes to
 * `ISessionInteractionService.onDidChangePending`, and for every newly-pending
 * `approval` / `question` interaction it calls `conn.requestPermission(...)`,
 * maps the response through the pure mappers in `./approval` / `./question`,
 * and settles the parked request via `interaction.respond(id, ...)`. The
 * default `SessionApprovalService` / `SessionQuestionService` stay in place —
 * the bridge never replaces them.
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import {
  type Interaction,
  type ISessionScopeHandle,
  ISessionInteractionService,
  type QuestionAnswers,
  type QuestionRequest,
  type SessionApprovalRequest as ApprovalRequest,
  type SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import { acpToolCallId } from './events-map';
import { log } from './log';
import { outcomeToQuestionAnswer, questionItemToPermissionOptions } from './question';

/** Disposable subscription handle returned by the event-bus `Event`. */
interface Disposable {
  dispose(): void;
}

export class AcpInteractionBridge {
  /** Ids the bridge has already begun handling — guards against re-entry. */
  private readonly inFlight = new Set<string>();
  private readonly subscription: Disposable;
  private readonly interaction: ISessionInteractionService;
  private disposed = false;

  constructor(
    private readonly conn: AgentSideConnection,
    sessionHandle: ISessionScopeHandle,
    private readonly sessionId: string,
  ) {
    this.interaction = sessionHandle.accessor.get(ISessionInteractionService);
    this.subscription = this.interaction.onDidChangePending(() => this.onPendingChanged());
    // Catch anything that was parked before the subscription attached.
    this.onPendingChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.inFlight.clear();
  }

  private onPendingChanged(): void {
    if (this.disposed) return;
    for (const interaction of this.interaction.listPending()) {
      if (this.inFlight.has(interaction.id)) continue;
      if (interaction.kind !== 'approval' && interaction.kind !== 'question') continue;
      this.inFlight.add(interaction.id);
      void this.dispatch(interaction);
    }
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    try {
      if (interaction.kind === 'approval') {
        const response = await this.handleApproval(interaction.payload as ApprovalRequest);
        this.interaction.respond(interaction.id, response);
        return;
      }
      if (interaction.kind === 'question') {
        const result = await this.handleQuestion(interaction.payload as QuestionRequest);
        this.interaction.respond(interaction.id, result);
      }
    } catch (error) {
      // `respond` itself never throws for a still-pending id, and the handlers
      // already swallow RPC failures into a safe response — so reaching here
      // means something unexpected broke. Log and settle with the safest
      // default so the gate/tool does not park forever.
      log.warn('acp: interaction bridge dispatch failed', {
        sessionId: this.sessionId,
        interactionId: interaction.id,
        kind: interaction.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      if (interaction.kind === 'approval') {
        this.interaction.respond(interaction.id, { decision: 'rejected' } satisfies ApprovalResponse);
      } else {
        this.interaction.respond(interaction.id, null);
      }
    }
  }

  /**
   * Bridge an engine {@link ApprovalRequest} to the ACP client and back. Any
   * RPC failure resolves with `decision: 'rejected'` — rejecting on failure is
   * strictly safer than approving when the client cannot confirm intent.
   */
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

  /**
   * Bridge an engine {@link QuestionRequest} (the AskUserQuestion tool) through
   * the same `session/request_permission` surface approvals use.
   *
   * Degradation rules:
   *  - `questions.length > 1` → only the first question is asked (logged).
   *  - `multiSelect === true` → still asked as single-select; the engine's
   *    ask-user tool tolerates a single-key answer for a multi-select prompt.
   *
   * Any RPC failure resolves with `null` so the tool takes its canonical
   * "user dismissed" branch — strictly safer than fabricating an answer.
   */
  private async handleQuestion(req: QuestionRequest): Promise<QuestionAnswers | null> {
    const questions = req.questions;
    if (questions.length === 0) {
      log.warn('acp: handleQuestion received empty questions array', {
        sessionId: this.sessionId,
      });
      return null;
    }
    if (questions.length > 1) {
      log.warn('acp: handleQuestion degrading to first question only', {
        sessionId: this.sessionId,
        dropped: questions.length - 1,
      });
    }
    const q = questions[0]!;
    const options = questionItemToPermissionOptions(q, 0);
    const rawToolCallId = req.toolCallId ?? 'ask-user';
    const toolCallId = req.turnId !== undefined ? acpToolCallId(req.turnId, rawToolCallId) : rawToolCallId;
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
