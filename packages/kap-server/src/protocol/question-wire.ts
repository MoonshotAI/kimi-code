import type {
  QuestionItem,
  QuestionOption,
  QuestionRequest,
} from '@moonshot-ai/agent-core-v2';

import type {
  QuestionItem as ProtocolQuestionItem,
  QuestionOption as ProtocolQuestionOption,
  QuestionRequest as ProtocolQuestionRequest,
} from './question';

export interface WireQuestionSource {
  readonly id: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

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
  out.allow_other = true;
  if (item.otherLabel !== undefined) out.other_label = item.otherLabel;
  if (item.otherDescription !== undefined) out.other_description = item.otherDescription;
  return out;
}

export function toWireQuestion(
  interaction: WireQuestionSource,
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
