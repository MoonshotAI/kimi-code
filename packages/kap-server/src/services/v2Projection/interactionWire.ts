import type {
  ApprovalRequest,
  ApprovalResponsePayload,
  QuestionRequest,
  QuestionResponsePayload,
} from '../../protocol/v2/messages/index';

function toWireOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const out: string[] = [];
  for (const option of options) {
    if (typeof option === 'string') out.push(option);
    else {
      const label = (option as { label?: unknown } | undefined)?.label;
      if (typeof label === 'string') out.push(label);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function toWireInteractionRequest(
  kind: 'approval' | 'question',
  payload: unknown,
  toolArgs?: unknown,
): ApprovalRequest | QuestionRequest | undefined {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p) return undefined;
  if (kind === 'approval') {
    const toolName = p['toolName'] ?? p['tool_name'];
    if (typeof toolName !== 'string') return undefined;
    const reason = p['reason'] ?? p['action'];
    return {
      tool_name: toolName,
      input: toolArgs ?? p['input'],
      reason: typeof reason === 'string' ? reason : undefined,
    };
  }
  const questions = p['questions'];
  if (!Array.isArray(questions)) return undefined;
  const mapped: QuestionRequest['questions'] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as { id?: unknown; question?: unknown; options?: unknown } | undefined;
    if (typeof q?.question !== 'string') return undefined;
    mapped.push({
      id: typeof q.id === 'string' ? q.id : `q_${i}`,
      question: q.question,
      options: toWireOptions(q.options),
    });
  }
  return { questions: mapped };
}

export function toWireInteractionResponse(
  kind: 'approval' | 'question',
  response: unknown,
): ApprovalResponsePayload | QuestionResponsePayload | undefined {
  if (response === null || response === undefined) return undefined;
  const r = response as Record<string, unknown>;
  if (kind === 'approval') {
    const decision = r['decision'];
    return {
      decision: decision === 'approved' || decision === 'rejected' ? decision : 'cancelled',
      feedback: typeof r['feedback'] === 'string' ? r['feedback'] : undefined,
    };
  }
  const answers = r['answers'];
  return {
    answers: (answers !== null && typeof answers === 'object' ? answers : {}) as Record<string, string>,
  };
}
