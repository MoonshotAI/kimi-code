export interface QuestionLike {
  question: string;
  multi_select?: boolean;
}

export interface QuestionFlow {
  questionIndex: number;
  answers: Record<string, string>;
  selections: Record<string, string[]>;
  customAnswers: Record<string, string>;
}

const ANSWER_SEPARATOR = ", ";

export function createQuestionFlow(_questions: readonly QuestionLike[]): QuestionFlow {
  return { questionIndex: 0, answers: {}, selections: {}, customAnswers: {} };
}

export function answerQuestion(
  flow: QuestionFlow,
  question: QuestionLike,
  answer: string,
): QuestionFlow {
  return withSelections(
    { ...flow, customAnswers: withoutKey(flow.customAnswers, question.question) },
    question,
    [answer],
  );
}

export function answerQuestionWithCustom(
  flow: QuestionFlow,
  question: QuestionLike,
  answer: string,
): QuestionFlow {
  const customAnswers = { ...flow.customAnswers, [question.question]: answer };
  const selections = question.multi_select ? flow.selections : withoutKey(flow.selections, question.question);
  return withAnswer({ ...flow, selections, customAnswers }, question);
}

export function toggleQuestionOption(
  flow: QuestionFlow,
  question: QuestionLike,
  option: string,
): QuestionFlow {
  if (!question.multi_select) return answerQuestion(flow, question, option);
  const current = flow.selections[question.question] ?? [];
  const selections = current.includes(option)
    ? current.filter((item) => item !== option)
    : [...current, option];
  return withSelections(flow, question, selections);
}

export function canAdvanceQuestion(flow: QuestionFlow, question: QuestionLike): boolean {
  return flow.answers[question.question] !== undefined;
}

export function moveQuestion(
  flow: QuestionFlow,
  offset: number,
  questionCount: number,
): QuestionFlow {
  const lastIndex = Math.max(0, questionCount - 1);
  return {
    ...flow,
    questionIndex: Math.min(lastIndex, Math.max(0, flow.questionIndex + offset)),
  };
}

function withSelections(
  flow: QuestionFlow,
  question: QuestionLike,
  selections: string[],
): QuestionFlow {
  return withAnswer(
    { ...flow, selections: { ...flow.selections, [question.question]: selections } },
    question,
  );
}

function withAnswer(flow: QuestionFlow, question: QuestionLike): QuestionFlow {
  const values = [
    ...(flow.selections[question.question] ?? []),
    ...(flow.customAnswers[question.question] ? [flow.customAnswers[question.question]] : []),
  ];
  const answers = { ...flow.answers };
  if (values.length === 0) delete answers[question.question];
  else answers[question.question] = values.join(ANSWER_SEPARATOR);
  return { ...flow, answers };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
