/**
 * `/sessions/{sid}/questions*` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions/{sid}/questions` wire contract on top of
 * `agent-core-v2` services. Backed by the Session-scoped `ISessionInteractionService`
 * (for the pending list + recently-resolved ledger) and `ISessionQuestionService`
 * (for `answer` / `dismiss`).
 *
 *   GET    /sessions/{sid}/questions?status=pending   data: { items: QuestionRequest[] }
 *   POST   /sessions/{sid}/questions/{qid}            body: QuestionResponse
 *                                                     data: { resolved: true, resolved_at }
 *   POST   /sessions/{sid}/questions/{qid}:dismiss    body: empty
 *                                                     envelope: code 40909
 *                                                     data: { dismissed: true, dismissed_at }
 *
 * **Fastify `:dismiss` action-suffix workaround** (ported from v1): we capture
 * the tail segment as `:tail` and parse via `parseActionSuffix`, because
 * Fastify cannot disambiguate `:question_id` from `:question_id:dismiss` on the
 * same path prefix. The POST body is therefore validated manually (the dismiss
 * path carries an empty body), not via the Zod preHandler.
 *
 * Error mapping (REST.md §3.6):
 *   - 40401 (session.not_found)        — no live session matches {sid}
 *   - 40405 (question.not_found)       — no pending question matches {qid}
 *   - 40902 (approval.already_resolved)— duplicate resolve; shared "already
 *                                        resolved" code, custom envelope
 *                                        `{code:40902, data:{resolved:false}}`
 *   - 40001 (validation.failed)        — bad suffix or bad body
 *   - 40909 (question.dismissed)       — successful dismiss envelope
 *
 * **Idempotency**: the interaction kernel remembers recently-resolved ids
 * (60s window). A re-POST of a just-resolved id hits `isRecentlyResolved` →
 * 40902; an id that never existed (or fell out of the window) → 40405.
 *
 * **Anti-corruption**: this is the single protocol↔in-process adapter for
 * questions. The v2 domain stores the in-process `QuestionRequest` (camelCase,
 * options without ids); the wire shape (snake_case, synthesized item/option
 * ids, 5-kind answer union) is derived here. On resolve, wire
 * ids are translated back to question text / option labels (reading the
 * pending request before it settles) so the flattened record the model sees
 * is self-explanatory. No `agent-core` (v1) imports.
 */

import {
  type Interaction,
  ISessionInteractionService,
  ISessionQuestionService,
  ISessionLifecycleService,
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
      const handle = await core.accessor.get(ISessionLifecycleService).resume(session_id);
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
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      const questionId = parsed.id;
      const action: 'resolve' | 'dismiss' = parsed.kind === 'bare' ? 'resolve' : parsed.action;

      const handle = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      const interaction = handle.accessor.get(ISessionInteractionService);
      const pendingInteraction = interaction
        .listPending('question')
        .find((i) => i.id === questionId);

      if (pendingInteraction === undefined) {
        if (interaction.isRecentlyResolved(questionId)) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED, // 40902 — shared "already_resolved"
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
          code: ErrorCode.QUESTION_DISMISSED, // 40909
          msg: `question ${questionId} dismissed`,
          data: { dismissed: true as const, dismissed_at: new Date().toISOString() },
          request_id: req.id,
        });
        return;
      }

      // action === 'resolve' — validate body manually (the route shape is
      // generic over `:tail` and the dismiss path uses an empty body).
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

      // The pending request must be projected BEFORE answer() settles (and
      // thereby drops) the kernel entry — its synthesized wire ids are the
      // lookup table for the id → text translation below.
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

// ---------------------------------------------------------------------------
// Protocol ↔ in-process adapter (ported from
// `packages/agent-core/src/services/question/question.ts`, reimplemented here
// so the edge never imports v1). Synthesizing stable ids (the SDK has no
// per-item / per-option id):
//   - QuestionItem.id   ← `q_<index>`              (e.g. `q_0`, `q_1`)
//   - QuestionOption.id ← `opt_<item>_<option>`    (e.g. `opt_0_0`)
// ---------------------------------------------------------------------------

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
  // The SDK has no allowOther field; always advertise the free-text Other option on the wire.
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

/**
 * Protocol REST response body → in-process `QuestionResponse`.
 *
 * The wire keeps synthesized ids (`q_<idx>` / `opt_<q>_<o>`) so clients can
 * answer unambiguously, but the flattened record is what the ask-user tool
 * feeds back to the model — so ids are translated back to text here using
 * the pending wire `request` (ported from v1's `toAgentCoreResponse`):
 *   - key               → the question's text (falls back to the raw qid
 *                         when the request is unavailable or the qid is
 *                         unknown — stale client, defensive)
 *   - single            → option label
 *   - multi             → labels.join(', ')
 *   - other             → text
 *   - multi_with_other  → [...labels, other_text].join(', ')
 *   - skipped           → OMIT entry
 *
 * Multi-select joins use `', '` to match what the TUI reverse-RPC path
 * already emits, so the model sees one format regardless of which client
 * answered.
 *
 * Unknown qids and option ids — including ids that belong to a DIFFERENT
 * question than the one being answered — are kept verbatim rather than
 * resolved or dropped: translating a cross-question id would hand the model
 * a plausible-looking label that was never offered for that question, while
 * the raw id stays diagnosable.
 */
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
    // Resolve option ids only within the answered question's own options
    // (at most 4, so a linear scan is fine).
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
        // Omitted from the record — matches SCHEMAS §6.4.
        break;
    }
  }
  const out: { answers: QuestionAnswers; method?: 'enter' | 'space' | 'number_key' } = {
    answers: flattened,
  };
  if (resp.method !== undefined && resp.method !== 'click') {
    // Protocol allows 'click'; the in-process method does not — drop it to
    // preserve type safety (the wire form keeps it for clients).
    out.method = resp.method;
  }
  return out;
}
