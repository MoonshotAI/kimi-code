/**
 * REST client for the pending-interactions endpoints:
 * `GET/POST {baseUrl}/api/v1/sessions/{sessionId}/approvals[/...]` and
 * `.../questions[/...]`.
 *
 * These are the only remaining surfaces for listing and answering a session's
 * pending approvals/questions: the engine's interaction kernel is a
 * process-global singleton with no DI channel on the `/api/v1/debug`
 * dispatcher, so the inspector talks to the same public REST surface the
 * clients use.
 */

export interface ApprovalWire {
  readonly approval_id: string;
  readonly session_id: string;
  readonly turn_id?: number;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly action: string;
  readonly tool_input_display: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface QuestionOptionWire {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItemWire {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOptionWire[];
  readonly multi_select?: boolean;
  readonly allow_other?: boolean;
  readonly other_label?: string;
  readonly other_description?: string;
}

export interface QuestionWire {
  readonly question_id: string;
  readonly session_id: string;
  readonly turn_id?: number;
  readonly tool_call_id?: string;
  readonly questions: readonly QuestionItemWire[];
  readonly created_at: string;
}

export type QuestionAnswerWire =
  | { readonly kind: 'single'; readonly option_id: string }
  | { readonly kind: 'multi'; readonly option_ids: readonly string[] }
  | { readonly kind: 'other'; readonly text: string }
  | {
      readonly kind: 'multi_with_other';
      readonly option_ids: readonly string[];
      readonly other_text: string;
    }
  | { readonly kind: 'skipped' };

export interface InteractionsApiOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly fetchImpl?: typeof fetch;
}

async function call<T>(
  opts: InteractionsApiOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  expectedCodes: readonly number[] = [0],
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token?.trim();
  if (token !== undefined && token !== '') {
    headers['authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (!expectedCodes.includes(envelope.code)) {
    throw new Error(`interactions call failed (${envelope.code}): ${envelope.msg}`);
  }
  return envelope.data as T;
}

export async function listPendingApprovals(
  opts: InteractionsApiOptions,
): Promise<readonly ApprovalWire[]> {
  const data = await call<{ items: readonly ApprovalWire[] }>(
    opts,
    'GET',
    '/approvals?status=pending',
  );
  return data.items;
}

export async function listPendingQuestions(
  opts: InteractionsApiOptions,
): Promise<readonly QuestionWire[]> {
  const data = await call<{ items: readonly QuestionWire[] }>(
    opts,
    'GET',
    '/questions?status=pending',
  );
  return data.items;
}

export function decideApproval(
  opts: InteractionsApiOptions,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<unknown> {
  return call(opts, 'POST', `/approvals/${encodeURIComponent(approvalId)}`, { decision });
}

export function answerQuestion(
  opts: InteractionsApiOptions,
  questionId: string,
  answers: Readonly<Record<string, QuestionAnswerWire>>,
  method?: 'enter' | 'space' | 'number_key' | 'click',
): Promise<unknown> {
  return call(opts, 'POST', `/questions/${encodeURIComponent(questionId)}`, { answers, method });
}

export function dismissQuestion(
  opts: InteractionsApiOptions,
  questionId: string,
): Promise<unknown> {
  // The dismiss endpoint reports success as a QUESTION_DISMISSED (40909)
  // envelope (see kap-server's question dismiss action), not code 0.
  return call(opts, 'POST', `/questions/${encodeURIComponent(questionId)}:dismiss`, undefined, [
    0,
    40909,
  ]);
}
