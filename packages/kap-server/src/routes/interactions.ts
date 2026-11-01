import {
  INTERACTION_TAG_SESSION_ID,
  interactions,
  resumeSessionById,
  type ApprovalResponse,
  type QuestionAnswers,
  type QuestionResult,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  interactionRespondParamsSchema,
  interactionRespondRequestSchema,
  interactionRespondResultSchema,
  type InteractionOutcome,
  type InteractionRespondRequest,
} from '../protocol/interaction';
import { type QuestionItem } from '../protocol/question';
import { toWireQuestion } from '../protocol/question-wire';

interface InteractionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

type QuestionRespondRequest = Extract<InteractionRespondRequest, { kind: 'question' }>;

export function registerInteractionsRoutes(app: InteractionRouteHost, core: Scope): void {
  const respondRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/interactions/{interaction_id}',
      params: interactionRespondParamsSchema,
      body: interactionRespondRequestSchema,
      success: { data: interactionRespondResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERACTION_NOT_FOUND]: {},
        [ErrorCode.INTERACTION_ENDED]: {},
      },
      description: 'Respond to a pending approval or question',
      tags: ['interactions'],
    },
    async (req, reply) => {
      const { session_id, interaction_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const tags = { [INTERACTION_TAG_SESSION_ID]: session_id };
      const pending = interactions.findOne({ id: interaction_id, resolved: false, tags });
      if (pending === undefined) {
        const ended = interactions.findOne({ id: interaction_id, resolved: true, tags });
        reply.send(
          ended === undefined
            ? errEnvelope(
                ErrorCode.INTERACTION_NOT_FOUND,
                `interaction ${interaction_id} not found`,
                req.id,
              )
            : errEnvelope(
                ErrorCode.INTERACTION_ENDED,
                `interaction ${interaction_id} has ended`,
                req.id,
              ),
        );
        return;
      }
      const body = req.body;
      if (pending.kind !== body.kind) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `interaction ${interaction_id} is a ${pending.kind}, not a ${body.kind}`,
            req.id,
          ),
        );
        return;
      }

      let outcome: InteractionOutcome;
      if (body.kind === 'approval') {
        const response: ApprovalResponse = {
          decision: body.decision,
          scope: body.scope,
          feedback: body.feedback,
          selectedLabel: body.selected_label,
        };
        interactions.respond(interaction_id, response);
        outcome = body.decision;
      } else if (body.dismissed === true) {
        interactions.respond(interaction_id, null);
        outcome = 'dismissed';
      } else {
        const { questions } = toWireQuestion(pending, session_id);
        interactions.respond(interaction_id, toQuestionResult(body, questions));
        outcome = 'answered';
      }
      requestLog(req)?.info(
        { session_id, interaction_id, kind: body.kind, outcome },
        'interaction responded',
      );
      reply.send(okEnvelope({ outcome, ended_at: new Date().toISOString() }, req.id));
    },
  );
  app.post(
    respondRoute.path,
    respondRoute.options,
    respondRoute.handler as Parameters<InteractionRouteHost['post']>[2],
  );
}

function toQuestionResult(
  body: QuestionRespondRequest,
  questions: readonly QuestionItem[],
): QuestionResult {
  const itemsById = new Map(questions.map((item) => [item.id, item]));
  const flattened: QuestionAnswers = {};
  for (const [qid, ans] of Object.entries(body.answers ?? {})) {
    const item = itemsById.get(qid);
    const key = item?.question ?? qid;
    const optionText = (id: string): string =>
      item?.options.find((o) => o.id === id)?.label ?? id;
    switch (ans.kind) {
      case 'single':
        flattened[key] = optionText(ans.option_id);
        break;
      case 'multi':
        flattened[key] = ans.option_ids.map(optionText).join(', ');
        break;
      case 'other':
        flattened[key] = ans.text;
        break;
      case 'multi_with_other':
        flattened[key] = [...ans.option_ids.map(optionText), ans.other_text].join(', ');
        break;
      case 'skipped':
        break;
    }
  }
  if (body.method === undefined || body.method === 'click') return { answers: flattened };
  return { answers: flattened, method: body.method };
}
