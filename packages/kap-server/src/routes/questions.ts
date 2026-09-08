import {
  INTERACTION_TAG_SESSION_ID,
  interactions,
  resumeSessionById,
  type Interaction,
  type QuestionAnswers,
  type QuestionResult,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  type QuestionItem as ProtocolQuestionItem,
  type QuestionRequest as ProtocolQuestionRequest,
  type QuestionResponse as ProtocolQuestionResponse,
} from '../protocol/question';
import { toWireQuestion } from '../protocol/question-wire';
import {
  listPendingQuestionsQuerySchema,
  listPendingQuestionsResponseSchema,
  questionAlreadyResolvedDataSchema,
  questionDismissResultSchema,
  questionResolveRequestSchema,
  questionResolveResultSchema,
} from '../protocol/rest-question';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { type ActionTable, runAction } from './action-dispatch';
import { parseActionSuffix } from './action-suffix';

interface QuestionRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const tailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerQuestionsRoutes(app: QuestionRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/questions',
      params: sessionIdParamSchema,
      querystring: listPendingQuestionsQuerySchema,
      success: { data: listPendingQuestionsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List pending question requests for a session',
      tags: ['questions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const pending = interactions.findAll({
        kind: 'question',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
      });
      const items = pending.map((i) => toWireQuestion(i, session_id));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<QuestionRouteHost['get']>[2]);

  const resolveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/questions/{tail}',
      params: tailParamsSchema,
      success: { data: questionResolveResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.QUESTION_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: {
          dataSchema: questionAlreadyResolvedDataSchema,
        },
        [ErrorCode.QUESTION_DISMISSED]: {
          dataSchema: questionDismissResultSchema,
        },
      },
      description: 'Resolve or dismiss a question',
      tags: ['questions'],
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['dismiss'] as const,
        defaultAction: 'resolve',
        resourceLabel: 'question',
      });

      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      let questionId: string;
      let action: 'resolve' | 'dismiss';
      if (parsed.kind === 'invalid') {
        if (
          interactions.findOne({
            id: tail,
            kind: 'question',
            resolved: false,
            tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
          }) !== undefined ||
          interactions.findOne({
            id: tail,
            kind: 'question',
            resolved: true,
            tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
          }) !== undefined
        ) {
          questionId = tail;
          action = 'resolve';
        } else {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
          return;
        }
      } else {
        questionId = parsed.id;
        action = parsed.kind === 'bare' ? 'resolve' : parsed.action;
      }

      const pendingInteraction = interactions.findOne({
        id: questionId,
        kind: 'question',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
      });

      if (pendingInteraction === undefined) {
        if (
          interactions.findOne({
            id: questionId,
            kind: 'question',
            resolved: true,
            tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
          }) !== undefined
        ) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
            msg: `question ${questionId} already resolved`,
            data: { resolved: false as const },
            request_id: req.id,
          });
          return;
        }
        reply.send(
          errEnvelope(ErrorCode.QUESTION_NOT_FOUND, `question ${questionId} not found`, req.id),
        );
        return;
      }

      await runAction({
        action,
        id: questionId,
        actions: questionActions,
        extra: { pendingInteraction, session_id, req, reply },
      });
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<QuestionRouteHost['post']>[2],
  );
}

type QuestionActionExtra = {
  readonly pendingInteraction: Interaction;
  readonly session_id: string;
  readonly req: { readonly id: string; readonly body: unknown };
  readonly reply: { readonly send: (payload: unknown) => unknown };
};

type QuestionActionCtx = QuestionActionExtra & { readonly id: string; readonly body: unknown };

const questionActions: ActionTable<'resolve' | 'dismiss', QuestionActionExtra> = {
  resolve: { handle: resolveQuestionAction },
  dismiss: { handle: dismissQuestionAction },
};

async function resolveQuestionAction(ctx: QuestionActionCtx): Promise<void> {
  const { pendingInteraction, session_id, req, reply, id } = ctx;
  const bodyParse = questionResolveRequestSchema.safeParse(req.body);
  if (!bodyParse.success) {
    const details = bodyParse.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const first = details[0];
    const msg =
      first === undefined
        ? 'validation failed'
        : first.path === ''
          ? first.message
          : `${first.path}: ${first.message}`;
    reply.send({
      code: ErrorCode.VALIDATION_FAILED,
      msg,
      data: null,
      request_id: req.id,
      details,
    });
    return;
  }

  const result = toInProcessResponse(bodyParse.data, toWireQuestion(pendingInteraction, session_id));
  interactions.respond(id, result);
  requestLog(req)?.info({ session_id, question_id: id, action: 'answer' }, 'question answered');
  reply.send(okEnvelope({ resolved: true as const, resolved_at: new Date().toISOString() }, req.id));
}

async function dismissQuestionAction(ctx: QuestionActionCtx): Promise<void> {
  const { session_id, req, reply, id } = ctx;
  interactions.respond(id, null);
  requestLog(req)?.info({ session_id, question_id: id, action: 'dismiss' }, 'question dismissed');
  reply.send({
    code: ErrorCode.QUESTION_DISMISSED,
    msg: `question ${id} dismissed`,
    data: { dismissed: true as const, dismissed_at: new Date().toISOString() },
    request_id: req.id,
  });
}

function toInProcessResponse(
  resp: ProtocolQuestionResponse,
  request?: ProtocolQuestionRequest,
): QuestionResult {
  const itemsById = new Map<string, ProtocolQuestionItem>();
  for (const item of request?.questions ?? []) {
    itemsById.set(item.id, item);
  }

  const flattened: QuestionAnswers = {};
  for (const [qid, ans] of Object.entries(resp.answers)) {
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
  const out: { answers: QuestionAnswers; method?: 'enter' | 'space' | 'number_key' } = {
    answers: flattened,
  };
  if (resp.method !== undefined && resp.method !== 'click') {
    out.method = resp.method;
  }
  return out;
}
