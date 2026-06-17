

import { ulid } from 'ulid';

import { Disposable, DisposableMap, IEventService, IQuestionService, questionDismissedResult, questionToBrokerRequest, ILogService, type IDisposable, type QuestionRequest, type QuestionResult } from '@moonshot-ai/agent-core';
import type {
  Event,
  QuestionRequest as ProtocolQuestionRequest,
} from '@moonshot-ai/protocol';


// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IQuestionService = IQuestionService;

export const QUESTION_DEFAULT_TIMEOUT_MS = 60_000;

export const QUESTION_RECENTLY_RESOLVED_CAP = 1024;

export class QuestionExpiredError extends Error {
  constructor(public readonly questionId: string, timeoutMs: number) {
    super(`question ${questionId} expired after ${timeoutMs}ms`);
    this.name = 'QuestionExpiredError';
  }
}

class PendingQuestion implements IDisposable {
  private _settled = false;

  constructor(
    readonly questionId: string,
    readonly sessionId: string,
    readonly toolCallId: string | undefined,
    readonly createdAt: string,
    readonly expiresAt: string,
    readonly protocolRequest: ProtocolQuestionRequest,
    private readonly _resolveFn: (r: QuestionResult) => void,
    private readonly _rejectFn: (e: Error) => void,
    private readonly _timer: NodeJS.Timeout,
  ) {}

  markSettled(): void {
    if (this._settled) return;
    this._settled = true;
    clearTimeout(this._timer);
  }

  resolve(r: QuestionResult): void {
    this._resolveFn(r);
  }

  reject(e: Error): void {
    this._rejectFn(e);
  }

  dispose(): void {
    if (this._settled) return;
    this._settled = true;
    clearTimeout(this._timer);
    try {
      this._rejectFn(new Error('server shutting down'));
    } catch {

    }
  }
}

export class QuestionService extends Disposable implements IQuestionService {
  readonly _serviceBrand: undefined;

  private readonly _pending: DisposableMap<string, PendingQuestion>;

  private readonly _recentlyResolved = new Set<string>();
  private _timeoutMs = QUESTION_DEFAULT_TIMEOUT_MS;
  private readonly _recentlyResolvedCap = QUESTION_RECENTLY_RESOLVED_CAP;

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this._pending = this._register(new DisposableMap<string, PendingQuestion>());
  }

  async request(
    req: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    if (this._store.isDisposed) {
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

    return new Promise<QuestionResult>((resolve, reject) => {
      const timer = setTimeout(() => this._expire(questionId), this._timeoutMs);
      timer.unref?.();
      this._pending.set(
        questionId,
        new PendingQuestion(
          questionId,
          req.sessionId,
          req.toolCallId,
          createdAt,
          expiresAt,
          protocolRequest,
          resolve,
          reject,
          timer,
        ),
      );
    });
  }

  resolve(id: string, response: QuestionResult): void {
    const p = this._pending.get(id);
    if (!p) return;
    p.markSettled();
    this._pending.deleteAndLeak(id);
    this.markResolved(p.questionId);

    const resolvedAt = new Date().toISOString();

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

  dismiss(id: string): void {
    const p = this._pending.get(id);
    if (!p) return;
    p.markSettled();
    this._pending.deleteAndLeak(id);
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

  isPending(questionId: string): boolean {
    return this._pending.has(questionId);
  }

  listPending(sessionId: string): ProtocolQuestionRequest[] {
    return Array.from(this._pending.values())
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.protocolRequest);
  }

  isRecentlyResolved(questionId: string): boolean {
    return this._recentlyResolved.has(questionId);
  }

  markResolved(questionId: string): void {
    if (this._recentlyResolved.size >= this._recentlyResolvedCap) {
      const oldest = this._recentlyResolved.values().next().value;
      if (oldest !== undefined) this._recentlyResolved.delete(oldest);
    }
    this._recentlyResolved.add(questionId);
  }

  _pendingCountForTest(): number {
    return this._pending.size;
  }

  _peekPendingForTest(
    questionId: string,
  ): { sessionId: string; toolCallId: string | undefined } | undefined {
    const p = this._pending.get(questionId);
    if (!p) return undefined;
    return { sessionId: p.sessionId, toolCallId: p.toolCallId };
  }

  _setTimeoutMsForTests(ms: number): void {
    this._timeoutMs = ms;
  }

  private _expire(questionId: string): void {
    const p = this._pending.get(questionId);
    if (!p) return;
    p.markSettled();
    this._pending.deleteAndLeak(questionId);
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
    if (this._store.isDisposed) return;
    this._recentlyResolved.clear();
    super.dispose();
  }
}
