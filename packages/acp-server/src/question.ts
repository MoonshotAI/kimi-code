/**
 * ACP `session/request_permission` ↔ agent-core-v2 ask-user mappers.
 *
 * ACP has no dedicated `session/request_question` method, so the AskUserQuestion
 * tool's question request is bridged through the same `requestPermission`
 * surface approvals use, with option ids tagged in a `q{n}_*` namespace so the
 * round-trip is unambiguous. Pure mappers — no IO — so the mappings stay
 * unit-testable without a live connection.
 */

import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk';
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
