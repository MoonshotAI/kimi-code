import type { ToolDefinition } from '@moonshot-ai/agent-core';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  isInteractionCancellation,
  type Interactions,
} from './interaction';
import DESCRIPTION from './ask-user.md?raw';

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: readonly QuestionOption[];
  readonly multi_select: boolean;
}

export interface AskUserQuestionInput {
  readonly background?: boolean;
  readonly questions: readonly QuestionItem[];
}

const QUESTION_UNIQUENESS_MESSAGE =
  'Question texts must be unique across questions, and option labels must be unique within each question.';

export function questionUniquenessError(questions: readonly QuestionItem[]): string | null {
  const texts = new Set<string>();
  for (const item of questions) {
    if (texts.has(item.question)) {
      return `Invalid questions: duplicate question text ${JSON.stringify(item.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
    }
    texts.add(item.question);
    const labels = new Set<string>();
    for (const option of item.options) {
      if (labels.has(option.label)) {
        return `Invalid questions: duplicate option label ${JSON.stringify(option.label)} in question ${JSON.stringify(item.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
      }
      labels.add(option.label);
    }
  }
  return null;
}

function readQuestions(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: QuestionItem[] = [];
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record['question'] !== 'string') continue;
    const optionsRaw = record['options'];
    const options: QuestionOption[] = [];
    if (Array.isArray(optionsRaw)) {
      for (const option of optionsRaw) {
        if (typeof option !== 'object' || option === null) continue;
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord['label'] !== 'string') continue;
        options.push({
          label: optionRecord['label'],
          description: typeof optionRecord['description'] === 'string' ? optionRecord['description'] : '',
        });
      }
    }
    items.push({
      question: record['question'],
      header: typeof record['header'] === 'string' ? record['header'] : '',
      options,
      multi_select: record['multi_select'] === true,
    });
  }
  return items;
}

export function createAskUserQuestionTool(
  interactions: Interactions,
  ids: { sessionId: string; agentId: string },
): ToolDefinition {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask the user (1-4 questions).',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean' },
            },
            required: ['question', 'options'],
          },
        },
        background: {
          type: 'boolean',
          description:
            'Set true to ask in the background and return immediately with a task_id. The answer arrives automatically in a later message — do not poll. Use WaitFor only if you later cannot proceed without the answer.',
        },
      },
      required: ['questions'],
    },
    async execute({ toolCall, detach }) {
      const args = JSON.parse(toolCall.arguments ?? '{}') as {
        questions?: unknown;
        background?: unknown;
      };
      const questions = readQuestions(args.questions);
      if (questions.length === 0) {
        return { content: [{ type: 'text', text: 'Provide at least one question.' }] };
      }
      const uniqueness = questionUniquenessError(questions);
      if (uniqueness !== null) {
        return { content: [{ type: 'text', text: uniqueness }] };
      }
      const payload: AskUserQuestionInput = {
        questions,
        background: args.background === true,
      };
      const tags = {
        [INTERACTION_TAG_SESSION_ID]: ids.sessionId,
        [INTERACTION_TAG_AGENT_ID]: ids.agentId,
        [INTERACTION_TAG_TOOL_CALL_ID]: toolCall.id,
      };
      if (payload.background === true) {
        detach?.(
          `task_id: ${toolCall.id}\nstatus: running\nnext_step: Continue your work; the answer arrives automatically in a later message. Use WaitFor only if you cannot proceed without it.`,
        );
      }
      const response = await interactions.request({ kind: 'question', payload, tags });
      if (isInteractionCancellation(response)) {
        return {
          content: [{ type: 'text', text: `Question cancelled (${response.reason}).` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    },
  };
}
