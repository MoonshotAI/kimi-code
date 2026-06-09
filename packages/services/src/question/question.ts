/**
 * Question service interface + protocol adapter.
 *
 * **Service interface** (`IQuestionService`): Reverse-RPC one-shot broker
 * role — routes `QuestionRequest`s coming out of `KimiCore` to a waiter
 * (web client over WS, mock handler in tests) and resolves the
 * promise when the response arrives — or `dismiss()`-es it if the user
 * closes the panel (SCHEMAS.md §6.3).
 *
 * Role: one-shot broker — see `packages/services/AGENTS.md`. Kept under the
 * `Service` suffix per the package-wide convention; the broker semantics
 * lives in the interface shape (`request` + `resolve` + `dismiss`) and the
 * docstring, not in the type name.
 *
 * **Shape note:** the service returns the in-process
 * `QuestionResult = null | QuestionAnswers | QuestionResponse` (see
 * `packages/agent-core/src/rpc/sdk-api.ts:48`). SCHEMAS.md §6.2/§6.4 defines
 * a protocol-level `QuestionResponse` with a 5-kind discriminated union
 * (`single` / `multi` / `other` / `multi_with_other` / `skipped`); the
 * protocol↔in-process adapter lives at the daemon boundary, NOT inside the
 * service interface. This keeps the SDK side of the adapter untouched and
 * confines protocol shape decisions to one place.
 *
 * **Adapter** (`toBrokerRequest` / `toAgentCoreResponse` / `dismissedResult`):
 * Bridges two representations of the same question interaction:
 *
 *   1. **In-process SDK shape** (agent-core, camelCase) — what
 *      `BridgeClientAPI` sees from `KimiCore.requestQuestion(...)`. See
 *      `packages/agent-core/src/rpc/sdk-api.ts:50-54`:
 *        `QuestionRequest { turnId?, toolCallId?, questions: QuestionItem[] }`
 *      where `QuestionItem` has `question, header?, body?, options[],
 *      multiSelect?, otherLabel?, otherDescription?`.
 *      `QuestionResult = null | QuestionAnswers | QuestionResponse`,
 *      `QuestionAnswers = Record<string, string | true>`.
 *
 *   2. **Protocol wire shape** (snake_case, with daemon-allocated metadata) —
 *      defined in `packages/protocol/src/question.ts`. 5-kind discriminated
 *      union for answers: `single | multi | other | multi_with_other | skipped`.
 *
 * **Synthesizing stable ids** (SDK has no per-item / per-option `id`):
 *   - `QuestionItem.id`     ← `q_<index>` (e.g. `q_0`, `q_1`, ...)
 *   - `QuestionOption.id`   ← `opt_<parent_idx>_<option_idx>` (e.g. `opt_0_0`)
 *
 * **Anti-corruption**: this is the ONLY place protocol↔SDK shape translation
 * happens for question.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type {
  QuestionAnswers as InProcessQuestionAnswers,
  QuestionItem as InProcessQuestionItem,
  QuestionRequest as InProcessQuestionRequest,
  QuestionRequest,
  QuestionResponse as InProcessQuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core';
import type {
  QuestionItem as ProtocolQuestionItem,
  QuestionOption as ProtocolQuestionOption,
  QuestionRequest as ProtocolQuestionRequest,
  QuestionResponse as ProtocolQuestionResponse,
} from '@moonshot-ai/protocol';
import type {} from '@moonshot-ai/protocol'; // type-only marker — keep protocol dep referenced

// Re-export for service-side consumers.
export type { QuestionRequest, QuestionResult };

export interface IQuestionService {
  readonly _serviceBrand: undefined;

  /**
   * Called by the adapter when KimiCore needs the user to answer a question.
   * Resolves with the in-process `QuestionResult` (null = no handler / fully
   * dismissed). Concrete impls own timeout policy.
   */
  request(req: InProcessQuestionRequest & { sessionId: string; agentId: string }): Promise<QuestionResult>;

  /**
   * Called by the answer-side (REST handler / TUI / mock) to settle a pending
   * `request()` with user answers. `id` matches `QuestionRequest`'s correlation
   * id (`turnId`+`toolCallId` today; SCHEMAS.md §6.2's `question_id` once the
   * protocol exposes it).
   */
  resolve(id: string, response: QuestionResult): void;

  /**
   * Called when the user dismisses the panel without answering (ESC / close).
   * Concrete impls resolve the pending `request()` with the equivalent of
   * `dismissedQuestionResult()` (`packages/agent-core` — see SCHEMAS.md §6.3).
   */
  dismiss(id: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IQuestionService = createDecorator<IQuestionService>('questionService');

// ---------------------------------------------------------------------------
// Adapter helpers (moved from adapter/question-adapter.ts)
// ---------------------------------------------------------------------------

export interface QuestionToBrokerRequestParams {
  /** Daemon-minted ULID identifying this question interaction. */
  readonly questionId: string;
  /** Session the question lives in. */
  readonly sessionId: string;
  /** `createdAt` ISO string; broker passes `new Date().toISOString()`. */
  readonly createdAt: string;
  /** `expiresAt` ISO string; broker computes `createdAt + 60s`. */
  readonly expiresAt: string;
}

/**
 * Build a protocol option from an SDK option. SDK has only `label?:string` +
 * `description?:string`; we synthesize `id` from parent and child indices so
 * `toAgentCoreAnswers` can map back through `Record<qid, string>`.
 */
function buildOption(
  opt: { readonly label: string; readonly description?: string },
  parentIdx: number,
  optIdx: number,
): ProtocolQuestionOption {
  const base: ProtocolQuestionOption = {
    id: `opt_${parentIdx}_${optIdx}`,
    label: opt.label,
  };
  return opt.description === undefined ? base : { ...base, description: opt.description };
}

/**
 * Build a protocol question item from an SDK item + its position. The
 * synthesized `id` (`q_<parentIdx>`) is the key the SDK answers Record uses.
 */
function buildItem(
  item: InProcessQuestionItem,
  parentIdx: number,
): ProtocolQuestionItem {
  const id = `q_${parentIdx}`;
  const out: ProtocolQuestionItem = {
    id,
    question: item.question,
    options: item.options.map((o, oi) => buildOption(o, parentIdx, oi)),
  };
  if (item.header !== undefined) out.header = item.header;
  if (item.body !== undefined) out.body = item.body;
  if (item.multiSelect !== undefined) out.multi_select = item.multiSelect;
  // SDK has no `allowOther` field — `otherLabel` / `otherDescription` exist
  // and we expose them on the wire alongside an inferred `allow_other: true`
  // when either tag is set. (SDK semantics: presence of `otherLabel` enables
  // the "Other" affordance; we surface that explicitly on the wire so client
  // renderers don't have to infer.)
  const hasOtherAffordance =
    item.otherLabel !== undefined || item.otherDescription !== undefined;
  if (hasOtherAffordance) out.allow_other = true;
  if (item.otherLabel !== undefined) out.other_label = item.otherLabel;
  if (item.otherDescription !== undefined) out.other_description = item.otherDescription;
  return out;
}

/**
 * In-process SDK request + daemon-allocated metadata → protocol wire shape.
 */
export function toBrokerRequest(
  req: InProcessQuestionRequest,
  params: QuestionToBrokerRequestParams,
): ProtocolQuestionRequest {
  const out: ProtocolQuestionRequest = {
    question_id: params.questionId,
    session_id: params.sessionId,
    questions: req.questions.map((q, i) => buildItem(q, i)),
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
  if (req.turnId !== undefined) out.turn_id = req.turnId;
  if (req.toolCallId !== undefined) out.tool_call_id = req.toolCallId;
  return out;
}

/**
 * Protocol REST response body → in-process SDK `QuestionResponse` (with
 * `answers` flattened to `Record<string, string | true>`).
 *
 * Normalization rules from SCHEMAS §6.4:
 *   - single            → option_id
 *   - multi             → option_ids.join(',')
 *   - other             → text
 *   - multi_with_other  → [...option_ids, other_text].join(',')
 *   - skipped           → OMIT entry
 */
export function toAgentCoreResponse(
  resp: ProtocolQuestionResponse,
): InProcessQuestionResponse {
  const flattened: InProcessQuestionAnswers = {};
  for (const [qid, ans] of Object.entries(resp.answers)) {
    switch (ans.kind) {
      case 'single':
        flattened[qid] = ans.option_id;
        break;
      case 'multi':
        flattened[qid] = ans.option_ids.join(',');
        break;
      case 'other':
        flattened[qid] = ans.text;
        break;
      case 'multi_with_other':
        flattened[qid] = [...ans.option_ids, ans.other_text].join(',');
        break;
      case 'skipped':
        // Omitted from the record — matches SCHEMAS §6.4 ("if skipped continue").
        break;
      default: {
        // Defensive: never-reached if Zod schema is the SOT, but TS narrowing
        // is exhaustive so this is unreachable.
        const _exhaustive: never = ans;
        void _exhaustive;
      }
    }
  }
  const out: InProcessQuestionResponse = { answers: flattened };
  if (resp.method !== undefined) {
    // SCHEMAS §6.2 protocol allows 'click' as a method; agent-core's in-process
    // `QuestionAnswerMethod` is `'enter' | 'space' | 'number_key'` (NO 'click').
    // Drop 'click' on the in-process side to preserve type safety; the wire
    // form keeps it for clients that want to surface the affordance used.
    if (resp.method !== 'click') {
      (out as { method?: typeof resp.method }).method = resp.method;
    }
  }
  return out;
}

/**
 * Convenience: SDK semantics for "dismiss the entire question group" is the
 * `null` QuestionResult. Exposed as a helper so daemon code reads
 * intentionally rather than litter `null` constants.
 */
export function dismissedResult(): null {
  return null;
}
