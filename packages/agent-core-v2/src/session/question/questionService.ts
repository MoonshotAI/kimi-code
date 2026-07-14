/**
 * `question` domain (L7) — `ISessionQuestionService` implementation.
 *
 * Typed facade over the `interaction` kernel for ask-user requests; owns no
 * pending state of its own (the kernel holds it). Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import {
  type QuestionRequest,
  type QuestionResult,
  ISessionQuestionService,
} from './question';

export class SessionQuestionService implements ISessionQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: QuestionRequest, options?: { signal?: AbortSignal }): Promise<QuestionResult> {
    const id = requestId(req);
    const pending = this.interaction.request<QuestionRequest, QuestionResult>({
      id,
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId },
    });

    const signal = options?.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        this.dismiss(id);
      } else {
        const onAbort = (): void => {
          this.dismiss(id);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void pending.finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
      }
    }
    return pending;
  }

  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string } {
    const id = requestId(req);
    this.interaction.enqueue<QuestionRequest>({
      id,
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId },
    });
    return { ...req, id };
  }

  answer(id: string, result: QuestionResult): void {
    this.interaction.respond(id, result);
  }

  dismiss(id: string): void {
    this.interaction.respond(id, null);
  }

  listPending(): readonly QuestionRequest[] {
    return this.interaction
      .listPending('question')
      .map((i) => i.payload as QuestionRequest);
  }
}

function requestId(req: QuestionRequest): string {
  return req.id ?? req.toolCallId ?? `question:${String(Date.now())}`;
}

registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, InstantiationType.Delayed, 'question');
