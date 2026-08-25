import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  enqueueSessionInteraction,
  listSessionPendingInteractions,
  requestSessionInteraction,
  respondSessionInteraction,
} from '#/features/interaction/sessionInteractions';

import {
  type QuestionRequest,
  type QuestionResult,
  ISessionQuestionService,
} from './question';

export class SessionQuestionService implements ISessionQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentLifecycleService private readonly agents: IAgentLifecycleService) {}

  request(req: QuestionRequest, options?: { signal?: AbortSignal; agentId?: string }): Promise<QuestionResult> {
    const id = requestId(req);
    const pending = requestSessionInteraction<QuestionRequest, QuestionResult>(this.agents, {
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
    enqueueSessionInteraction<QuestionRequest>(this.agents, {
      id,
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId },
    });
    return { ...req, id };
  }

  answer(id: string, result: QuestionResult): void {
    respondSessionInteraction(this.agents, id, result);
  }

  dismiss(id: string): void {
    respondSessionInteraction(this.agents, id, null);
  }

  listPending(): readonly QuestionRequest[] {
    return listSessionPendingInteractions(this.agents, 'question')
      .map((i) => ({ ...(i.payload as QuestionRequest), id: i.id }));
  }
}

function requestId(req: QuestionRequest): string {
  return req.id ?? `question_${randomUUID()}`;
}

registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, ScopeActivation.OnScopeCreated, 'question');
