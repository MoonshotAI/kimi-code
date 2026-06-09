/**
 * `QuestionService` (daemon-side `IQuestionService` impl).
 *
 * One-shot broker for Question (data-collection) interaction. Mirrors
 * `ApprovalService` with one addition: `dismiss(id)` is a first-class outcome
 * (SCHEMAS.md §6.3) — the user closes the panel without answering;
 * agent-core's pending Promise resolves with `null` (NOT a rejection).
 *
 *   1. `request(req)`:
 *        - Mints `question_id = ulid()`.
 *        - Builds protocol `QuestionRequest` via the services adapter
 *          (`questionToBrokerRequest`).
 *        - Broadcasts `event.question.requested` through `IEventService.publish`.
 *        - Holds the Promise + 60s timer; on resolve, settles with normalized
 *          answers; on dismiss, settles with `null`; on timeout, broadcasts
 *          `event.question.expired` and rejects with `QuestionExpiredError`.
 *
 *   2. `resolve(questionId, response)`:
 *        - Broadcasts `event.question.answered`.
 *        - Settles Promise with adapter-normalized `Record<string, string|true>`.
 *
 *   3. `dismiss(questionId)`:
 *        - Broadcasts `event.question.dismissed`.
 *        - Settles Promise with `null` (== SCHEMAS §6.3 dismissed result).
 *
 * **Anti-corruption**: imports `@moonshot-ai/services` (service interface +
 * adapter) and `@moonshot-ai/protocol` (Event type). No direct node-sdk
 * references — in-process `QuestionRequest`/`QuestionResult` flow through
 * the services re-export.
 */

import { ulid } from 'ulid';

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  Event,
  QuestionRequest as ProtocolQuestionRequest,
} from '@moonshot-ai/protocol';
import {
  IEventService,
  IQuestionService,
  questionDismissedResult,
  questionToBrokerRequest,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/services';

import { ILogService } from '#/services/logger';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IQuestionService = IQuestionService;

/** Default 60s timeout per SCHEMAS §6.2 / §6.3. Overridable for tests. */
export const QUESTION_DEFAULT_TIMEOUT_MS = 60_000;

/** Cap on recently-resolved bookkeeping ring (idempotency window). */
export const QUESTION_RECENTLY_RESOLVED_CAP = 1024;

/**
 * Thrown when the 60s timer fires before `resolve()` / `dismiss()` is called.
 */
export class QuestionExpiredError extends Error {
  constructor(public readonly questionId: string, timeoutMs: number) {
    super(`question ${questionId} expired after ${timeoutMs}ms`);
    this.name = 'QuestionExpiredError';
  }
}

interface PendingQuestion {
  readonly questionId: string;
  readonly sessionId: string;
  readonly toolCallId: string | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly protocolRequest: ProtocolQuestionRequest;
  resolve: (r: QuestionResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class QuestionService extends Disposable implements IQuestionService {
  readonly _serviceBrand: undefined;

  /** Indexed by daemon-minted `question_id` (REST path key). */
  private readonly _pending = new Map<string, PendingQuestion>();
  /** Bounded set of resolved/dismissed ids for idempotency. */
  private readonly _recentlyResolved = new Set<string>();
  private _timeoutMs = QUESTION_DEFAULT_TIMEOUT_MS;
  private readonly _recentlyResolvedCap = QUESTION_RECENTLY_RESOLVED_CAP;

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
  }

  async request(
    req: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    if (this._isDisposed) {
      throw new Error('question service disposed');
    }

    const questionId = ulid();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this._timeoutMs).toISOString();

    const protocolRequest = questionToBrokerRequest(req, {
      questionId,
      sessionId: req.sessionId,
      createdAt,
      expiresAt,
    });

    const event: Event = {
      type: 'event.question.requested',
      sessionId: req.sessionId,
      agentId: req.agentId,
      ...protocolRequest,
    } as unknown as Event;
    this.eventService.publish(event);

    this.logger.info(
      {
        questionId,
        sessionId: req.sessionId,
        agentId: req.agentId,
        toolCallId: req.toolCallId,
        questionCount: req.questions.length,
      },
      'question requested',
    );

    return await new Promise<QuestionResult>((resolve, reject) => {
      const timer = setTimeout(() => this._expire(questionId), this._timeoutMs);
      timer.unref?.();
      this._pending.set(questionId, {
        questionId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        createdAt,
        expiresAt,
        protocolRequest,
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Settle a pending question with answers (normalized to in-process shape
   * by the REST handler via `questionToAgentCoreResponse`). Broadcasts
   * `event.question.answered` before settling. Silent no-op for unknown ids.
   */
  resolve(id: string, response: QuestionResult): void {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this.markResolved(p.questionId);

    const resolvedAt = new Date().toISOString();
    // For broadcast, we forward the in-process answers map directly so all
    // subscribers see consistent shape. (REST handler stamps the wire shape
    // before this broadcast; in-process internal callers receive the SDK
    // shape.)
    const answeredEvent: Event = {
      type: 'event.question.answered',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
      answers: response === null ? null : (response as { answers?: unknown }).answers ?? response,
      resolved_at: resolvedAt,
    } as unknown as Event;
    this.eventService.publish(answeredEvent);

    p.resolve(response);
  }

  /**
   * SCHEMAS §6.3 dismiss path. Broadcasts `event.question.dismissed` BEFORE
   * settling the Promise with `null` (== `dismissedQuestionResult()` in
   * agent-core). Silent no-op for unknown ids.
   */
  dismiss(id: string): void {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this.markResolved(p.questionId);

    const dismissedAt = new Date().toISOString();
    const dismissedEvent: Event = {
      type: 'event.question.dismissed',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
      dismissed_at: dismissedAt,
    } as unknown as Event;
    this.eventService.publish(dismissedEvent);

    p.resolve(questionDismissedResult());
  }

  /**
   * Has-pending check used by REST routes to discriminate 40404 vs proceed.
   */
  isPending(questionId: string): boolean {
    return this._pending.has(questionId);
  }

  listPending(sessionId: string): ProtocolQuestionRequest[] {
    return Array.from(this._pending.values())
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.protocolRequest);
  }

  /** Has-recently-resolved-or-dismissed check for 40902 idempotency. */
  isRecentlyResolved(questionId: string): boolean {
    return this._recentlyResolved.has(questionId);
  }

  /** Stamp an id as resolved/dismissed for the idempotency window. */
  markResolved(questionId: string): void {
    if (this._recentlyResolved.size >= this._recentlyResolvedCap) {
      const oldest = this._recentlyResolved.values().next().value;
      if (oldest !== undefined) this._recentlyResolved.delete(oldest);
    }
    this._recentlyResolved.add(questionId);
  }

  /** Test helper — number of pending questions. */
  _pendingCountForTest(): number {
    return this._pending.size;
  }

  /** Test helper — pending entry snapshot. */
  _peekPendingForTest(
    questionId: string,
  ): { sessionId: string; toolCallId: string | undefined } | undefined {
    const p = this._pending.get(questionId);
    if (!p) return undefined;
    return { sessionId: p.sessionId, toolCallId: p.toolCallId };
  }

  /** Test helper — override the default 60s timeout. */
  _setTimeoutMsForTests(ms: number): void {
    this._timeoutMs = ms;
  }

  private _expire(questionId: string): void {
    const p = this._pending.get(questionId);
    if (!p) return;
    this._pending.delete(questionId);
    this.markResolved(p.questionId);

    const expiredEvent: Event = {
      type: 'event.question.expired',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
    } as unknown as Event;
    this.eventService.publish(expiredEvent);

    p.reject(new QuestionExpiredError(p.questionId, this._timeoutMs));
  }

  override dispose(): void {
    if (this._isDisposed) return;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      try {
        p.reject(new Error('daemon shutting down'));
      } catch {
        // ignore
      }
    }
    this._pending.clear();
    this._recentlyResolved.clear();
    super.dispose();
  }
}
