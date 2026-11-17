import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

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
  opts: {
    timeoutMs?: number;
    baseUrl?: string;
    feedbackUrl?: string;
    headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<FetchCreateFeedbackUploadUrlResult> {
  const url =
    opts.feedbackUrl === undefined
      ? kimiCodeFeedbackUploadUrl(opts.baseUrl)
      : `${opts.feedbackUrl.replace(/\/+$/, '')}/upload_url`;
  const result = await postJson(url, accessToken, body, opts);
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
  opts: {
    timeoutMs?: number;
    baseUrl?: string;
    feedbackUrl?: string;
    headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<FetchCompleteFeedbackUploadResult> {
  const url =
    opts.feedbackUrl === undefined
      ? kimiCodeFeedbackUploadCompleteUrl(opts.baseUrl)
      : `${opts.feedbackUrl.replace(/\/+$/, '')}/upload_complete`;
  const result = await postJson(url, accessToken, body, opts);
  if (result.kind === 'error') return result;
  return { kind: 'ok' };
}

async function postJson(
  url: string,
  accessToken: string,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Readonly<Record<string, string>> },
): Promise<{ readonly kind: 'ok'; readonly payload: unknown } | FetchFeedbackUploadError> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
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

export interface FeedbackArchivePart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface CreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CreateFeedbackUploadUrlResult {
  readonly uploadId: number;
  readonly parts: readonly FeedbackArchivePart[];
}

export interface CompletedUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface CompleteFeedbackUploadUrlInput {
  readonly uploadId: number;
  readonly parts: readonly CompletedUploadPart[];
}

export interface FeedbackUploadUrlApi {
  createUploadUrl(input: CreateFeedbackUploadUrlInput): Promise<CreateFeedbackUploadUrlResult>;
  completeUpload(input: CompleteFeedbackUploadUrlInput): Promise<void>;
}

export interface FeedbackUploadArchive {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UploadArchiveOptions {
  readonly filename: string;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

const MAX_ARCHIVE_SIZE = 524_288_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PART_TIMEOUT_MS = 60_000;
const RETRY_BASE_DELAY_MS = 1_000;

export async function uploadArchive<T extends FeedbackUploadArchive>(
  api: FeedbackUploadUrlApi,
  archive: T,
  feedbackId: number,
  options: UploadArchiveOptions,
): Promise<void> {
  if (archive.size > MAX_ARCHIVE_SIZE) {
    throw new Error(
      `Failed to upload archive: size ${archive.size} exceeds maximum allowed size ${MAX_ARCHIVE_SIZE}.`,
    );
  }
  const created = await api.createUploadUrl({
    feedbackId,
    filename: options.filename,
    size: archive.size,
    sha256: archive.sha256,
  });
  const completed = await uploadParts(archive.path, created.parts, archive.size, options);
  await api.completeUpload({ uploadId: created.uploadId, parts: completed });
}

interface PartLayout {
  readonly part: FeedbackArchivePart;
  readonly start: number;
}

function layoutParts(parts: readonly FeedbackArchivePart[]): PartLayout[] {
  const sorted = parts.toSorted((a, b) => a.partNumber - b.partNumber);
  let offset = 0;
  return sorted.map((part) => {
    const start = offset;
    offset += part.size;
    return { part, start };
  });
}

async function uploadParts(
  filePath: string,
  parts: readonly FeedbackArchivePart[],
  totalBytes: number,
  options: UploadArchiveOptions,
): Promise<CompletedUploadPart[]> {
  const layout = layoutParts(parts);
  const results: CompletedUploadPart[] = Array.from({ length: layout.length });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, layout.length));
  let nextIndex = 0;
  let uploadedBytes = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= layout.length) return;
      const entry = layout[index];
      if (entry === undefined) return;
      const completed = await uploadOnePartWithRetry(filePath, entry, options);
      results[index] = completed;
      uploadedBytes += entry.part.size;
      options.onProgress?.(uploadedBytes, totalBytes);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function uploadOnePartWithRetry(
  filePath: string,
  layout: PartLayout,
  options: UploadArchiveOptions,
): Promise<CompletedUploadPart> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await uploadOnePart(filePath, layout, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryable(error)) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

async function uploadOnePart(
  filePath: string,
  layout: PartLayout,
  options: UploadArchiveOptions,
): Promise<CompletedUploadPart> {
  const { part, start } = layout;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PART_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const stream = createReadStream(filePath, { start, end: start + part.size - 1 });
  try {
    const res = await fetch(part.url, {
      method: part.method,
      body: Readable.toWeb(stream),
      headers: { 'Content-Length': String(part.size) },
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UploadPartHttpError(part.partNumber, res.status, text);
    }
    const etag = res.headers.get('etag');
    if (etag === null || etag.length === 0) {
      throw new Error(`Failed to upload part ${part.partNumber}: missing ETag in response.`);
    }
    return { partNumber: part.partNumber, etag };
  } catch (error) {
    stream.destroy();
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Failed to upload part ${part.partNumber}: upload timed out.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class UploadPartHttpError extends Error {
  constructor(
    readonly partNumber: number,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(
      `Failed to upload part ${partNumber}: HTTP ${String(status)}${responseBody.length > 0 ? ` ${responseBody}` : ''}`,
    );
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UploadPartHttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
