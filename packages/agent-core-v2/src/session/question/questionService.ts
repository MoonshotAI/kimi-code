import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  isInteractionCancellation,
  type InteractionTags,
} from '#/human/interaction/interaction';
import { ISessionInteractionService } from '#/session/interaction/sessionInteractionService';

import {
  type QuestionRequest,
  type QuestionResult,
  ISessionQuestionService,
} from './question';

export class SessionQuestionService implements ISessionQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionInteractionService private readonly interactions: ISessionInteractionService,
  ) {}

  request(
    req: QuestionRequest,
    options?: { signal?: AbortSignal; agentId?: string; detached?: boolean },
  ): Promise<QuestionResult> {
    const id = requestId(req);
    const pending = this.interactions
      .request<QuestionRequest, unknown>({
        id,
        kind: 'question',
        payload: req,
        tags: questionTags(req, options),
      })
      .then((response) => (isInteractionCancellation(response) ? null : (response as QuestionResult)));

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
    this.interactions.enqueue<QuestionRequest>({
      id,
      kind: 'question',
      payload: req,
      tags: questionTags(req),
    });
    return { ...req, id };
  }

  answer(id: string, result: QuestionResult): void {
    this.interactions.respond(id, result);
  }

  dismiss(id: string): void {
    this.interactions.respond(id, null);
  }

  listPending(): readonly QuestionRequest[] {
    return this.interactions
      .findAll({ kind: 'question', resolved: false })
      .map((i) => ({ ...(i.payload as QuestionRequest), id: i.id }));
  }
}

function requestId(req: QuestionRequest): string {
  return req.id ?? `question_${randomUUID()}`;
}

function questionTags(
  req: QuestionRequest,
  options?: { agentId?: string; detached?: boolean },
): InteractionTags {
  const tags: InteractionTags = {};
  const turnId = options?.detached === true ? undefined : req.turnId;
  if (turnId !== undefined) tags[INTERACTION_TAG_TURN_ID] = turnId;
  if (options?.agentId !== undefined) tags[INTERACTION_TAG_AGENT_ID] = options.agentId;
  if (req.toolCallId !== undefined) tags[INTERACTION_TAG_TOOL_CALL_ID] = req.toolCallId;
  return tags;
}

registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, ScopeActivation.OnScopeCreated, 'question');
