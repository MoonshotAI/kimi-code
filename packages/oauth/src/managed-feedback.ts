/**
 * Submit user feedback to the managed Kimi Code platform.
 *
 * POSTs a JSON body to `{kimiCodeBaseUrl}/feedback` with a Bearer access
 * token. The client tags `version` with a `kimi-code-` prefix so the
 * backend can identify this client.
 */

import { readApiErrorMessage } from './api-error';
import { kimiCodeBaseUrl } from './managed-usage';

export interface SubmitFeedbackBody {
  readonly session_id: string;
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

export async function fetchSubmitFeedback(
  url: string,
  accessToken: string,
  body: SubmitFeedbackBody,
  opts: { timeoutMs?: number } = {},
): Promise<FetchSubmitFeedbackResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        kind: 'error',
        status: res.status,
        message: await readApiErrorMessage(
          res,
          `Failed to submit feedback: HTTP ${String(res.status)}`,
        ),
      };
    }
    const feedbackId = parseFeedbackId(await res.json());
    if (feedbackId === undefined) {
      return { kind: 'error', message: 'Failed to submit feedback: missing feedback_id.' };
    }
    return { kind: 'ok', feedbackId };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to submit feedback: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to submit feedback: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseFeedbackId(payload: unknown): number | undefined {
  const direct = readFeedbackId(payload);
  if (direct !== undefined) return direct;
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return readFeedbackId((payload as { readonly data: unknown }).data);
  }
  return undefined;
}

function readFeedbackId(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const value = record['feedback_id'] ?? record['id'];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
