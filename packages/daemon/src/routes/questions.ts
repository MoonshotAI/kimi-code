/**
 * `/sessions/{sid}/questions*` REST routes.
 *
 * 3 endpoints (REST.md §3.6), with the POST endpoints serviced by a SINGLE
 * Fastify route handler
 * because Fastify cannot disambiguate `:question_id` vs `:question_id:dismiss`
 * on the same path prefix. Questions has both a bare resolve and a `:dismiss`,
 * so we use the tail parser for both:
 *
 *   GET    /sessions/{sid}/questions?status=pending
 *     data: { items: QuestionRequest[] }
 *
 *   POST   /sessions/{sid}/questions/{qid}             (resolve)
 *     body: QuestionResponse (5-kind answers map + method?+ note?)
 *     data: { resolved: true, resolved_at }
 *
 *   POST   /sessions/{sid}/questions/{qid}:dismiss     (first-class
 *     body: empty                                          dismiss)
 *     envelope: code: 40909, data: { dismissed: true, dismissed_at }
 *
 * **Fastify `:dismiss` action-suffix workaround**: we capture the tail segment
 * as `:tail` and parse via `lastIndexOf(':')`. This keeps bare resolve and
 * `:dismiss` on one route without ambiguous Fastify path syntax.
 *
 * Error mapping (REST.md §3.6):
 *   - 40404 (question.not_found)
 *   - 40902 (question.already_resolved) — custom envelope w/ data:{resolved:false}
 *   - 40001 (validation.failed)         — bad body via Zod
 *   - 40909 (question.dismissed)        — successful dismiss envelope
 *
 * **Anti-corruption**: route resolves `IQuestionService` via the accessor;
 * no SDK imports.
 */

import {
  ErrorCode,
  listPendingQuestionsQuerySchema,
  listPendingQuestionsResponseSchema,
  questionResolveRequestSchema,
  questionResolveResultSchema,
} from '@moonshot-ai/protocol';
import {
  IQuestionService,
  questionToAgentCoreResponse,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';
import { QuestionService } from '#/services/question';

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

export function registerQuestionsRoutes(
  app: QuestionRouteHost,
  ix: IInstantiationService,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/questions',
      params: sessionIdParamSchema,
      querystring: listPendingQuestionsQuerySchema,
      success: { data: listPendingQuestionsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(
            z.object({ path: z.string(), message: z.string() }),
          ),
        },
      },
      description: 'List pending questions for a session',
      tags: ['questions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const broker = ix.invokeFunction((a) =>
        a.get(IQuestionService) as QuestionService,
      );
      reply.send(okEnvelope({ items: broker.listPending(session_id) }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<QuestionRouteHost['get']>[2],
  );

  const route = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/questions/{tail}',
      params: tailParamsSchema,
      success: { data: questionResolveResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(
            z.object({ path: z.string(), message: z.string() }),
          ),
        },
        [ErrorCode.QUESTION_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: { dataSchema: z.object({ resolved: z.literal(false) }) },
        [ErrorCode.QUESTION_DISMISSED]: {
          dataSchema: z.object({
            dismissed: z.boolean(),
            dismissed_at: z.string(),
          }),
        },
      },
      description: 'Resolve or dismiss a question',
      tags: ['questions'],
    },
    async (req, reply) => {
      const { tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['dismiss'] as const,
        defaultAction: 'resolve',
        resourceLabel: 'question',
      });
      if (parsed.kind === 'invalid') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
        );
        return;
      }
      const questionId = parsed.id;
      const action: 'resolve' | 'dismiss' =
        parsed.kind === 'bare' ? 'resolve' : parsed.action;

      if (!questionId) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'invalid question_id in path',
            req.id,
          ),
        );
        return;
      }

      const broker = ix.invokeFunction((a) =>
        a.get(IQuestionService) as QuestionService,
      );

      if (!broker.isPending(questionId)) {
        if (broker.isRecentlyResolved(questionId)) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED, // 40902 — shared "already_resolved"
            msg: `question ${questionId} already resolved`,
            data: { resolved: false },
            request_id: req.id,
          });
          return;
        }
        reply.send(
          errEnvelope(
            ErrorCode.QUESTION_NOT_FOUND,
            `question ${questionId} not found`,
            req.id,
          ),
        );
        return;
      }

      if (action === 'dismiss') {
        broker.dismiss(questionId);
        reply.send({
          code: ErrorCode.QUESTION_DISMISSED, // 40909
          msg: `question ${questionId} dismissed`,
          data: { dismissed: true, dismissed_at: new Date().toISOString() },
          request_id: req.id,
        });
        return;
      }

      // action === 'resolve' — validate body manually (we can't use the Zod
      // preHandler here because the route shape is generic over `:tail` and
      // the dismiss path uses an empty body).
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

      const body = bodyParse.data;
      const inProc = questionToAgentCoreResponse(body);
      broker.resolve(questionId, inProc);
      broker.markResolved(questionId);

      const result = {
        resolved: true,
        resolved_at: new Date().toISOString(),
      };
      reply.send(okEnvelope(result, req.id));
    },
  );

  app.post(
    route.path,
    route.options,
    route.handler as Parameters<QuestionRouteHost['post']>[2],
  );
}
