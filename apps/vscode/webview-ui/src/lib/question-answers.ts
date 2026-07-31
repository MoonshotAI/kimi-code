import type { QuestionItem } from "shared/legacy-sdk";

/**
 * Per-question form state collected by QuestionDialog, keyed by question index.
 */
export interface QuestionFormState {
  /** Single-select questions: the chosen option index. */
  single: Record<number, number | undefined>;
  /** Multi-select questions: the chosen option indexes. */
  multi: Record<number, ReadonlySet<number> | undefined>;
  /** Per-question free-text input. */
  custom: Record<number, string | undefined>;
}

/**
 * Build the answers record submitted to the agent, keyed by question text.
 *
 * - Single-select: a non-empty custom text wins over the chosen option.
 * - Multi-select: chosen labels joined with `', '` (the TUI convention),
 *   with a non-empty custom text appended as an extra label.
 * - Questions without any answer are omitted; an all-empty form yields `{}`,
 *   which the agent treats as the user dismissing the question.
 */
export function buildQuestionAnswers(
  questions: QuestionItem[],
  state: QuestionFormState,
): Record<string, string> {
  const answers: Record<string, string> = {};

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (!question) continue;
    const options = question.options ?? [];
    const custom = state.custom[i]?.trim();

    if (question.multi_select) {
      const labels: string[] = [];
      const selected = state.multi[i];
      if (selected) {
        for (let j = 0; j < options.length; j++) {
          const label = options[j]?.label;
          if (selected.has(j) && label) labels.push(label);
        }
      }
      if (custom) labels.push(custom);
      if (labels.length > 0) answers[question.question] = labels.join(", ");
      continue;
    }

    if (custom) {
      answers[question.question] = custom;
      continue;
    }
    const chosen = state.single[i];
    const label = chosen === undefined ? undefined : options[chosen]?.label;
    if (label) answers[question.question] = label;
  }

  return answers;
}
