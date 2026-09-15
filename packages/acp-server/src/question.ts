/**
 * ACP `session/request_permission` ↔ agent-core-v2 ask-user mappers.
 *
 * ACP has no dedicated `session/request_question` method, so the AskUserQuestion
 * tool's question request is bridged through the same `requestPermission`
 * surface approvals use, with option ids tagged in a `q{n}_*` namespace so the
 * round-trip is unambiguous. Pure mappers — no IO — so the mappings stay
 * unit-testable without a live connection.
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  EnumOption,
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { QuestionAnswers, QuestionItem } from '@moonshot-ai/agent-core-v2';

/**
 * `optionId` namespace for the AskUserQuestion bridge.
 *
 * The wire-level `PermissionOption.optionId` is opaque to the client (it
 * round-trips back via `RequestPermissionResponse.outcome.optionId`), so the
 * host is free to pick any stable string. The `questionIndex` is embedded in
 * the prefix so future multi-question support does not need a wire-format
 * change: `q0_opt_*` / `q1_opt_*` are already non-conflicting.
 */
function optOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}_opt_${optionIndex}`;
}

function skipOptionId(questionIndex: number): string {
  return `q${questionIndex}_skip`;
}

/**
 * Map a tool-side {@link QuestionItem} into ACP {@link PermissionOption}[].
 *
 * Layout:
 *  - One `allow_once` option per `question.options[i]` (label preserved
 *    verbatim — it is the same string surfaced back to the engine as a
 *    `QuestionAnswers` value).
 *  - One trailing `reject_once` "Skip" option so the user can dismiss the
 *    prompt without forcing an answer (the engine's ask-user tool resolves
 *    dismissal as `question_dismissed`).
 *
 * `questionIndex` is currently always `0` (the bridge degrades multi-question
 * to single-question); the namespace is wired in so future multi-question
 * support is a pure handler change with no wire-format break.
 */
export function questionItemToPermissionOptions(
  question: QuestionItem,
  questionIndex: number,
): readonly PermissionOption[] {
  const options: PermissionOption[] = question.options.map((opt, i) => ({
    optionId: optOptionId(questionIndex, i),
    name: opt.label,
    kind: 'allow_once' as const,
  }));
  options.push({
    optionId: skipOptionId(questionIndex),
    name: 'Skip',
    kind: 'reject_once' as const,
  });
  return options;
}

/**
 * Reverse-map an ACP {@link RequestPermissionResponse} into a tool-side
 * {@link QuestionAnswers} payload, returning `null` when the user dismissed
 * (skip / cancel) or selected an unknown option.
 *
 * Defensive on out-of-bounds / unknown optionIds: returning `null` rather than
 * throwing keeps the bridge robust against stale or custom options surfaced by
 * the client.
 */
export function outcomeToQuestionAnswer(
  question: QuestionItem,
  response: RequestPermissionResponse,
): QuestionAnswers | null {
  if (response.outcome.outcome === 'cancelled') return null;
  const optionId = response.outcome.optionId;
  if (optionId === skipOptionId(0)) return null;
  const match = /^q0_opt_(\d+)$/.exec(optionId);
  if (!match) return null;
  const optionIndex = Number(match[1]);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  const selected = question.options[optionIndex];
  if (!selected) return null;
  return { [question.question]: selected.label };
}

// ---------------------------------------------------------------------------
// Elicitation bridge (`elicitation/create`, form mode)
// ---------------------------------------------------------------------------

/** Property key for question `i` in the elicitation form schema. */
function questionPropertyKey(questionIndex: number): string {
  return `q${questionIndex}`;
}

/** Titled enum options shared by the single- (`oneOf`) and multi- (`anyOf`) select arms. */
function titledEnumOptions(question: QuestionItem): EnumOption[] {
  return question.options.map((opt) => ({
    const: opt.label,
    title: opt.label,
    description: opt.description,
  }));
}

/**
 * Map a tool-side question set into an `elicitation/create` form-mode request.
 *
 * Unlike the `request_permission` bridge (single question, single select),
 * the form schema carries EVERY question natively: single-select questions
 * become `type: 'string'` + `oneOf`, `multiSelect` questions become
 * `type: 'array'` + `items.anyOf` (with `minItems: 1`, since every question
 * is required). The form-level `message` joins the question texts; each
 * field is titled by the question's `header` (falling back to the full
 * question text) and described by its `body`.
 *
 * The synthetic "Other" free-text option (`otherLabel`) has no elicitation
 * equivalent without an extra text field; it stays unsupported for now,
 * matching the `request_permission` bridge.
 */
export function questionRequestToElicitationParams(
  questions: readonly QuestionItem[],
  sessionId: string,
  toolCallId?: string,
): Extract<CreateElicitationRequest, { mode: 'form' }> {
  const properties: Record<string, ElicitationPropertySchema> = {};
  const required: string[] = [];
  questions.forEach((q, i) => {
    const key = questionPropertyKey(i);
    required.push(key);
    const title = q.header ?? q.question;
    properties[key] =
      q.multiSelect === true
        ? {
            type: 'array',
            title,
            description: q.body,
            minItems: 1,
            items: { anyOf: titledEnumOptions(q) },
          }
        : {
            type: 'string',
            title,
            description: q.body,
            oneOf: titledEnumOptions(q),
          };
  });
  return {
    sessionId,
    toolCallId,
    mode: 'form',
    message: questions.map((q) => q.question).join('\n'),
    requestedSchema: { type: 'object', properties, required },
  };
}

/**
 * Reverse-map an `elicitation/create` response into a tool-side
 * {@link QuestionAnswers} payload. `decline` / `cancel` (and an `accept`
 * without content) resolve to `null` — the tool's canonical "user dismissed"
 * branch. Multi-select values join with `', '` in DECLARED option order,
 * matching the TUI's `QuestionDialog` encoding. Values outside the declared
 * options are dropped defensively; an accept that answers nothing resolves
 * to `null` as well.
 */
export function elicitationResponseToQuestionAnswers(
  questions: readonly QuestionItem[],
  response: CreateElicitationResponse,
): QuestionAnswers | null {
  if (response.action !== 'accept') return null;
  const content = (response as { content?: Record<string, unknown> | null }).content;
  if (content === null || content === undefined) return null;
  const answers: QuestionAnswers = {};
  questions.forEach((q, i) => {
    const value = content[questionPropertyKey(i)];
    if (q.multiSelect === true) {
      if (!Array.isArray(value)) return;
      const picked = q.options
        .map((opt) => opt.label)
        .filter((label) => value.includes(label));
      if (picked.length > 0) answers[q.question] = picked.join(', ');
      return;
    }
    if (typeof value === 'string' && q.options.some((opt) => opt.label === value)) {
      answers[q.question] = value;
    }
  });
  return Object.keys(answers).length > 0 ? answers : null;
}
