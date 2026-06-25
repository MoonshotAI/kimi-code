

import { ulid } from 'ulid';

import { Disposable, DisposableMap, IEventService, IQuestionService, questionDismissedResult, questionToBrokerRequest, ILogService, type IDisposable, type QuestionRequest, type QuestionResult } from '@moonshot-ai/agent-core';
import type {
  Event,
  QuestionRequest as ProtocolQuestionRequest,
} from '@moonshot-ai/protocol';


// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IQuestionService = IQuestionService;

export const QUESTION_RECENTLY_RESOLVED_CAP = 1024;

class PendingQuestion implements IDisposable {
  private _settled = false;
  private _abortCleanup: (() => void) | undefined;

  constructor(
    readonly questionId: string,
    readonly sessionId: string,
    readonly toolCallId: string | undefined,
    readonly createdAt: string,
    readonly protocolRequest: ProtocolQuestionRequest,
    private readonly _resolveFn: (r: QuestionResult) => void,
    private readonly _rejectFn: (e: Error) => void,
  ) {}

  setAbortCleanup(cleanup: () => void): void {
    this._abortCleanup = cleanup;
  }

  markSettled(): void {
    if (this._settled) return;
    this._settled = true;
    this._abortCleanup?.();
    this._abortCleanup = undefined;
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
    this._abortCleanup?.();
    this._abortCleanup = undefined;
    try {
      this.reject(new Error('server shutting down'));
    } catch {

    }
  }
}

export class QuestionService extends Disposable implements IQuestionService {
  readonly _serviceBrand: undefined;

  private readonly _pending: DisposableMap<string, PendingQuestion>;

  private readonly _recentlyResolved = new Set<string>();
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
    options?: { signal?: AbortSignal },
  ): Promise<QuestionResult> {
    if (this._store.isDisposed) {
      throw new Error('question service disposed');
    }

    const questionId = ulid();
    const createdAt = new Date().toISOString();

    const protocolRequest = questionToBrokerRequest(req, {
      questionId,
      sessionId: req.sessionId,
      createdAt,
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
      const pending = new PendingQuestion(
        questionId,
        req.sessionId,
        req.toolCallId,
        createdAt,
        protocolRequest,
        resolve,
        reject,
      );
      this._pending.set(questionId, pending);

      // When the agent's turn is aborted, the broker entry must be settled so
      // listPending()/session status don't stay stuck in awaiting_question.
      const signal = options?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.dismiss(questionId);
        } else {
          const onAbort = () => this.dismiss(questionId);
          signal.addEventListener('abort', onAbort, { once: true });
          pending.setAbortCleanup(() => signal.removeEventListener('abort', onAbort));
        }
      }
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

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._recentlyResolved.clear();
    super.dispose();
  }
}
