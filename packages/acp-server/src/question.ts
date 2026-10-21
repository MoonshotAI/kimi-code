import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  EnumOption,
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { QuestionAnswers, QuestionItem } from '@moonshot-ai/agent-core-v2';

function optOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}_opt_${optionIndex}`;
}

function skipOptionId(questionIndex: number): string {
  return `q${questionIndex}_skip`;
}

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

function questionPropertyKey(questionIndex: number): string {
  return `q${questionIndex}`;
}

function titledEnumOptions(question: QuestionItem): EnumOption[] {
  return question.options.map((opt) => ({
    const: opt.label,
    title: opt.label,
    description: opt.description,
  }));
}

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
