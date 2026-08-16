/**
 * `question` domain — `ISessionQuestionService` implementation.
 *
 * Typed facade over the `interaction` kernel for ask-user requests; owns no
 * pending state of its own (the kernel holds it). Interaction ids are minted
 * here (`question_<uuid>`) — never derived from the provider's toolCallId,
 * which is not unique across responses on some self-hosted endpoints and stays
 * on the payload for correlation only. `listPending` merges the parked id back
 * into each returned request so hosts can `answer`/`dismiss` without kernel
 * access. Bound at Session scope.
 */

import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import {
  type QuestionRequest,
  type QuestionResult,
  ISessionQuestionService,
} from './question';

export class SessionQuestionService implements ISessionQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: QuestionRequest, options?: { signal?: AbortSignal; agentId?: string }): Promise<QuestionResult> {
    const id = requestId(req);
    const pending = this.interaction.request<QuestionRequest, QuestionResult>({
      id,
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId, agentId: options?.agentId },
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
      .map((i) => ({ ...(i.payload as QuestionRequest), id: i.id }));
  }
}

function requestId(req: QuestionRequest): string {
  return req.id ?? `question_${randomUUID()}`;
}

registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, ScopeActivation.OnScopeCreated, 'question');
