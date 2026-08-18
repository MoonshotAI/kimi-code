import {
  type Interaction,
  ISessionInteractionService,
  ISessionQuestionService,
  resumeSessionById,
  type QuestionAnswers,
  type QuestionItem,
  type QuestionOption,
  type QuestionRequest,
  type QuestionResult,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  type QuestionItem as ProtocolQuestionItem,
  type QuestionOption as ProtocolQuestionOption,
  type QuestionRequest as ProtocolQuestionRequest,
  type QuestionResponse as ProtocolQuestionResponse,
} from '../protocol/question';
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
      const pending = handle.accessor.get(ISessionInteractionService).listPending('question');
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

      const interaction = handle.accessor.get(ISessionInteractionService);

      let questionId: string;
      let action: 'resolve' | 'dismiss';
      if (parsed.kind === 'invalid') {
        if (
          interaction.listPending('question').some((i) => i.id === tail) ||
          interaction.isRecentlyResolved(tail)
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

      const pendingInteraction = interaction
        .listPending('question')
        .find((i) => i.id === questionId);

      if (pendingInteraction === undefined) {
        if (interaction.isRecentlyResolved(questionId)) {
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

      const questions = handle.accessor.get(ISessionQuestionService);

      if (action === 'dismiss') {
        questions.dismiss(questionId);
        requestLog(req)?.info(
          { session_id, question_id: questionId, action: 'dismiss' },
          'question dismissed',
        );
        reply.send({
          code: ErrorCode.QUESTION_DISMISSED,
          msg: `question ${questionId} dismissed`,
          data: { dismissed: true as const, dismissed_at: new Date().toISOString() },
          request_id: req.id,
        });
        return;
      }

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

      const result = toInProcessResponse(
        bodyParse.data,
        toWireQuestion(pendingInteraction, session_id),
      );
      questions.answer(questionId, result);
      requestLog(req)?.info(
        { session_id, question_id: questionId, action: 'answer' },
        'question answered',
      );
      reply.send(
        okEnvelope({ resolved: true as const, resolved_at: new Date().toISOString() }, req.id),
      );
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<QuestionRouteHost['post']>[2],
  );
}

function buildOption(opt: QuestionOption, itemIdx: number, optIdx: number): ProtocolQuestionOption {
  const base: ProtocolQuestionOption = { id: `opt_${itemIdx}_${optIdx}`, label: opt.label };
  return opt.description === undefined ? base : { ...base, description: opt.description };
}

function buildItem(item: QuestionItem, itemIdx: number): ProtocolQuestionItem {
  const out: ProtocolQuestionItem = {
    id: `q_${itemIdx}`,
    question: item.question,
    options: item.options.map((o, oi) => buildOption(o, itemIdx, oi)),
  };
  if (item.header !== undefined) out.header = item.header;
  if (item.body !== undefined) out.body = item.body;
  if (item.multiSelect !== undefined) out.multi_select = item.multiSelect;
  out.allow_other = true;
  if (item.otherLabel !== undefined) out.other_label = item.otherLabel;
  if (item.otherDescription !== undefined) out.other_description = item.otherDescription;
  return out;
}

/** In-process request + interaction metadata → protocol wire shape. */
export function toWireQuestion(
  interaction: Interaction,
  sessionId: string,
): ProtocolQuestionRequest {
  const req = interaction.payload as QuestionRequest;
  const createdAt = new Date(interaction.createdAt).toISOString();
  const out: ProtocolQuestionRequest = {
    question_id: interaction.id,
    session_id: sessionId,
    questions: req.questions.map((q, i) => buildItem(q, i)),
    created_at: createdAt,
  };
  if (req.turnId !== undefined) out.turn_id = req.turnId;
  if (req.toolCallId !== undefined) out.tool_call_id = req.toolCallId;
  return out;
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
