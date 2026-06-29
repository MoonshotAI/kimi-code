import { readApiErrorMessage } from './api-error';
import { kimiCodeBaseUrl } from './managed-usage';

export interface CreateFeedbackUploadUrlBody {
  readonly file_hash: string;
  readonly file_name: string;
  readonly file_size: number;
  readonly feedback_id: number;
}

export interface FeedbackUploadPart {
  readonly part_number: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface CreateFeedbackUploadUrlResponse {
  readonly upload_id: number;
  readonly parts: readonly FeedbackUploadPart[];
}

export interface CompleteFeedbackUploadPart {
  readonly part_number: number;
  readonly etag: string;
}

export interface CompleteFeedbackUploadBody {
  readonly upload_id: number;
  readonly parts: readonly CompleteFeedbackUploadPart[];
}

export interface FetchFeedbackUploadError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export interface FetchCompleteFeedbackUploadOk {
  readonly kind: 'ok';
}

export type FetchCreateFeedbackUploadUrlResult =
  | ({ readonly kind: 'ok' } & CreateFeedbackUploadUrlResponse)
  | FetchFeedbackUploadError;

export type FetchCompleteFeedbackUploadResult =
  | FetchCompleteFeedbackUploadOk
  | FetchFeedbackUploadError;

export function kimiCodeFeedbackUploadUrl(baseUrl?: string): string {
  return `${feedbackBaseUrl(baseUrl)}/feedback/upload_url`;
}

export function kimiCodeFeedbackUploadCompleteUrl(baseUrl?: string): string {
  return `${feedbackBaseUrl(baseUrl)}/feedback/upload_complete`;
}

export async function fetchCreateFeedbackUploadUrl(
  accessToken: string,
  body: CreateFeedbackUploadUrlBody,
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<FetchCreateFeedbackUploadUrlResult> {
  const result = await postJson(kimiCodeFeedbackUploadUrl(opts.baseUrl), accessToken, body, opts);
  if (result.kind === 'error') return result;
  const parsed = readUpload(result.payload);
  if (parsed === undefined) {
    return { kind: 'error', message: 'Feedback upload request failed: missing upload id or parts.' };
  }
  return { kind: 'ok', upload_id: parsed.uploadId, parts: parsed.parts };
}

export async function fetchCompleteFeedbackUpload(
  accessToken: string,
  body: CompleteFeedbackUploadBody,
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<FetchCompleteFeedbackUploadResult> {
  const result = await postJson(kimiCodeFeedbackUploadCompleteUrl(opts.baseUrl), accessToken, body, opts);
  if (result.kind === 'error') return result;
  return { kind: 'ok' };
}

async function postJson(
  url: string,
  accessToken: string,
  body: unknown,
  opts: { timeoutMs?: number },
): Promise<{ readonly kind: 'ok'; readonly payload: unknown } | FetchFeedbackUploadError> {
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
        message: await readApiErrorMessage(res, `Feedback upload request failed: HTTP ${res.status}`),
      };
    }
    const text = await res.text();
    return { kind: 'ok', payload: text.length > 0 ? JSON.parse(text) : {} };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Feedback upload request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Feedback upload request failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function feedbackBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '');
}

function readUpload(
  payload: unknown,
): { readonly uploadId: number; readonly parts: FeedbackUploadPart[] } | undefined {
  const upload = readRecord(payload, 'upload');
  if (typeof upload !== 'object' || upload === null) return undefined;
  const record = upload as Record<string, unknown>;
  const uploadId = readNumberField(record, 'id');
  const partsRaw = record['parts'];
  if (!Array.isArray(partsRaw) || partsRaw.length === 0) return undefined;
  const parts: FeedbackUploadPart[] = [];
  for (const item of partsRaw) {
    const part = readPart(item);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return uploadId === undefined ? undefined : { uploadId, parts };
}

function readPart(item: unknown): FeedbackUploadPart | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const partNumber = readNumberField(record, 'part_number');
  const url = readStringField(record, 'url');
  const size = readNumberField(record, 'size');
  if (partNumber === undefined || url === undefined || size === undefined) return undefined;
  return { part_number: partNumber, url, method: readStringField(record, 'method') ?? 'PUT', size };
}

function readRecord(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function readNumberField(payload: unknown, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readStringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
