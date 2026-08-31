import type {
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { QuestionAnswers, QuestionItem } from '@moonshot-ai/kimi-code-sdk';

function optOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}_opt_${optionIndex}`;
}

function doneOptionId(questionIndex: number): string {
  return `q${questionIndex}_done`;
}

function skipOptionId(questionIndex: number): string {
  return `q${questionIndex}_skip`;
}

export function questionItemToPermissionOptions(
  question: QuestionItem,
  questionIndex: number,
  selectedOptions: ReadonlySet<number> = new Set<number>(),
): readonly PermissionOption[] {
  const options: PermissionOption[] = question.options.map((opt, i) => ({
    optionId: optOptionId(questionIndex, i),
    name: selectedOptions.has(i) ? `✓ ${opt.label}` : opt.label,
    kind: 'allow_once' as const,
  }));
  if (question.multiSelect === true && selectedOptions.size > 0) {
    options.push({
      optionId: doneOptionId(questionIndex),
      name: 'Done',
      kind: 'allow_once' as const,
    });
  }
  options.push({
    optionId: skipOptionId(questionIndex),
    name: 'Skip',
    kind: 'reject_once' as const,
  });
  return options;
}

export type QuestionPermissionOutcome =
  | { readonly kind: 'option'; readonly optionIndex: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'cancelled' };

export function permissionResponseToQuestionOutcome(
  question: QuestionItem,
  questionIndex: number,
  response: RequestPermissionResponse,
): QuestionPermissionOutcome {
  if (response.outcome.outcome === 'cancelled') return { kind: 'cancelled' };
  const optionId = response.outcome.optionId;
  if (optionId === skipOptionId(questionIndex)) return { kind: 'skip' };
  if (question.multiSelect === true && optionId === doneOptionId(questionIndex)) {
    return { kind: 'done' };
  }
  const match = new RegExp(`^q${String(questionIndex)}_opt_(\\d+)$`).exec(optionId);
  if (!match) return { kind: 'cancelled' };
  const optionIndex = Number(match[1]);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || !question.options[optionIndex]) {
    return { kind: 'cancelled' };
  }
  return { kind: 'option', optionIndex };
}

export function outcomeToQuestionAnswer(
  question: QuestionItem,
  response: RequestPermissionResponse,
): QuestionAnswers | null {
  const outcome = permissionResponseToQuestionOutcome(question, 0, response);
  if (outcome.kind !== 'option') return null;
  const selected = question.options[outcome.optionIndex]!;
  return { [question.question]: selected.label };
}
