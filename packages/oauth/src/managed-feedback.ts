import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import { kimiCodeBaseUrl } from './managed-usage';

export interface SubmitFeedbackBody {
  readonly session_id?: string;
  readonly content: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export interface FetchSubmitFeedbackOk {
  readonly kind: 'ok';
  readonly feedbackId: number;
}

export interface FetchSubmitFeedbackError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export type FetchSubmitFeedbackResult = FetchSubmitFeedbackOk | FetchSubmitFeedbackError;

export function kimiCodeFeedbackUrl(baseUrl?: string): string {
  return `${(baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/feedback`;
}

export interface FeedbackRequestOptions {
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly redirect?: 'error';
  readonly signal?: AbortSignal;
}

export async function fetchSubmitFeedback(
  url: string,
  accessToken: string,
  body: SubmitFeedbackBody,
  opts: FeedbackRequestOptions = {},
): Promise<FetchSubmitFeedbackResult> {
  const result = await postFeedbackJson(url, accessToken, body, opts, 'submit');
  if (result.kind === 'error') return result;
  const feedbackId = parseFeedbackId(result.payload);
  return feedbackId === undefined
    ? { kind: 'error', message: 'Failed to submit feedback: missing feedback_id.' }
    : { kind: 'ok', feedbackId };
}

export interface UpdateFeedbackBody {
  readonly feedback_id: number;
  readonly content?: string;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export async function fetchUpdateFeedback(
  url: string,
  accessToken: string,
  body: UpdateFeedbackBody,
): Promise<{ readonly kind: 'ok' } | FetchSubmitFeedbackError> {
  const result = await postFeedbackJson(`${url.replace(/\/+$/, '')}/update`, accessToken, body, { redirect: 'error' }, 'update');
  return result.kind === 'error' ? result : { kind: 'ok' };
}

const failureMessages = {
  submit: 'Failed to submit feedback',
  update: 'Failed to update feedback',
  upload: 'Feedback upload request failed',
} as const;

export async function postFeedbackJson(
  url: string,
  accessToken: string,
  body: unknown,
  opts: FeedbackRequestOptions,
  operation: keyof typeof failureMessages,
): Promise<{ kind: 'ok'; payload: unknown } | FetchSubmitFeedbackError> {
  const failure = failureMessages[operation];
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...opts.headers,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]),
      redirect: opts.redirect,
    });
    if (!res.ok) {
      return { kind: 'error', status: res.status, message: await readApiErrorMessage(res, `${failure}: HTTP ${res.status}`) };
    }
    const text = await res.text();
    const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;
    if (isRecord(payload) && typeof payload['code'] === 'number' && payload['code'] !== 0) {
      return { kind: 'error', message: 'The feedback service rejected the request.' };
    }
    return { kind: 'ok', payload };
  } catch (error) {
    if (timeout.aborted) {
      return { kind: 'error', message: operation === 'upload' ? 'Feedback upload request timed out.' : `${failure}: request timed out.` };
    }
    return { kind: 'error', message: `${failure}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseFeedbackId(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  return readFeedbackId(payload) ?? readFeedbackId(payload['data']);
}

function readFeedbackId(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload['feedback_id'] ?? payload['id'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
