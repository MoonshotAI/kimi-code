
import { buildRestUrl } from '../config';
import { noopTracer } from '../../contracts';
import type { ClientIdentity, CredentialStore, Tracer } from '../../contracts';
import { DaemonApiError, DaemonNetworkError, FileTooLargeError } from '../errors';
import type { WireEnvelope } from './wire';
import type { MediaBlobOptions, ReadRequestOptions } from '../types';
import { BackgroundRequestQueue } from './backgroundRequests';

const REQUEST_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 5 * 60_000;
export const FORK_TIMEOUT_MS = 5 * 60_000;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_PREVIEW_LIMIT = 500;
const ERROR_ENVELOPE_MAX_BYTES = 64 * 1024;

export const SERVER_AUTH_UNAUTHORIZED_CODE = 40101;

export interface DaemonEnvelope<T> {
  data: T;
  details: unknown;
}

export interface DaemonHttpClientOptions {
  origin: string;
  identity?: ClientIdentity;
  tracer?: Tracer;
  credentialStore?: CredentialStore;
}

export type RestQueryValue = string | number | boolean | undefined;
export type RestQuery = Record<string, RestQueryValue | readonly RestQueryValue[]>;

export interface DaemonRequestOptions extends ReadRequestOptions {
  allowCodes?: number[];
  timeoutMs?: number;
}

function appendQuery(params: URLSearchParams, query: RestQuery): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) params.append(key, String(item));
      }
    } else {
      params.set(key, String(value));
    }
  }
}

function timeoutSignal(timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    return undefined;
  }
}

function combinedSignal(timeoutMs: number, caller: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutSignal(timeoutMs);
  if (timeout === undefined) return caller;
  try {
    return AbortSignal.any([timeout, caller]);
  } catch {
    return caller;
  }
}

function encodeBase32(value: number, length: number): string {
  let out = '';
  let next = value;
  for (let i = 0; i < length; i++) {
    out = ULID_ALPHABET[next % 32] + out;
    next = Math.floor(next / 32);
  }
  return out;
}

function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => ULID_ALPHABET[byte % 32]).join('');
}

function createRequestId(): string {
  return `${encodeBase32(Date.now(), 10)}${randomBase32(16)}`;
}

function describeFormData(formData: FormData): unknown {
  try {
    const fields: Array<Record<string, unknown>> = [];
    formData.forEach((value, field) => {
      if (typeof value === 'string') {
        fields.push({ field, value });
      } else {
        fields.push({ field, file: value.name, size: value.size, type: value.type });
      }
    });
    return { formData: fields };
  } catch {
    return '[FormData]';
  }
}

async function readResponsePreview(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    return text.length > BODY_PREVIEW_LIMIT ? `${text.slice(0, BODY_PREVIEW_LIMIT)}...` : text;
  } catch {
    return undefined;
  }
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ERROR_ENVELOPE_MAX_BYTES) return undefined;
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function isErrorEnvelope(value: unknown, requestId: string): value is WireEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Partial<WireEnvelope<unknown>>;
  return typeof envelope.code === 'number'
    && envelope.code !== 0
    && typeof envelope.msg === 'string'
    && envelope.data === null
    && envelope.request_id === requestId;
}

function traceRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return headers['Authorization'] === undefined ? { ...headers } : { ...headers, Authorization: 'Bearer ***' };
}

function traceResponseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers);
}

export class DaemonHttpClient {
  private readonly backgroundRequests = new BackgroundRequestQueue();
  private readonly tracer: Tracer;

  constructor(private readonly opts: DaemonHttpClientOptions) {
    this.tracer = opts.tracer ?? noopTracer;
  }

  dispose(): void {
    this.backgroundRequests.dispose();
  }

  async get<T>(path: string, query?: RestQuery, opts?: DaemonRequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, query, opts);
  }

  async getBlob(
    path: string,
    query?: RestQuery,
    opts?: MediaBlobOptions & { maxBytes?: number },
  ): Promise<Blob> {
    let url = buildRestUrl(this.opts.origin, path);
    if (query) {
      const params = new URLSearchParams();
      appendQuery(params, query);
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }
    const requestId = createRequestId();
    const headers: Record<string, string> = { 'X-Request-Id': requestId };
    this.addClientHeaders(headers);
    if (opts?.prefixBytes !== undefined) {
      if (!Number.isSafeInteger(opts.prefixBytes) || opts.prefixBytes < 1) {
        throw new RangeError('Media prefix size must be a positive integer');
      }
      headers.Range = `bytes=0-${opts.prefixBytes - 1}`;
    }
    const startedAt = Date.now();
    this.tracer.restRequest?.({ method: 'GET', path, url, requestId, headers: traceRequestHeaders(headers) });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: opts?.signal ? combinedSignal(REQUEST_TIMEOUT_MS, opts.signal) : timeoutSignal(),
      });
    } catch (err) {
      this.tracer.restFailure?.({
        method: 'GET',
        path,
        requestId,
        phase: 'fetch',
        durationMs: Date.now() - startedAt,
        error: err,
      });
      throw new DaemonNetworkError({
        message: `Network error calling GET ${path}`,
        cause: err,
        method: 'GET',
        path,
        url,
        requestId,
        phase: 'fetch',
        timeoutMs: REQUEST_TIMEOUT_MS,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    const limit = opts?.prefixBytes ?? opts?.maxBytes;
    if (response.ok && limit !== undefined && contentLength > limit) {
      this.tracer.restResponse?.({
        method: 'GET',
        path,
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        durationMs: Date.now() - startedAt,
        code: 0,
        msg: '',
      });
      void response.body?.cancel();
      throw new FileTooLargeError({ size: contentLength, limit });
    }
    let envelope: WireEnvelope<unknown> | undefined;
    if (
      response.ok
      && contentLength <= ERROR_ENVELOPE_MAX_BYTES
      && response.headers.get('content-type')?.toLowerCase().includes('application/json')
    ) {
      const candidate = await readJsonWithLimit(response.clone());
      if (isErrorEnvelope(candidate, requestId)) envelope = candidate;
    }
    if (response.ok && envelope === undefined) {
      this.tracer.restResponse?.({
        method: 'GET',
        path,
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        durationMs: Date.now() - startedAt,
        code: 0,
        msg: '',
      });
      if (opts?.prefixBytes !== undefined && response.body !== null) {
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > opts.prefixBytes) {
              throw new FileTooLargeError({ size, limit: opts.prefixBytes });
            }
            chunks.push(new Uint8Array(value));
          }
          return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return response.blob();
    }
    if (!response.ok) {
      try {
        envelope = (await response.clone().json()) as WireEnvelope<unknown>;
      } catch {}
    }
    this.checkAuthRequired(response, envelope?.code ?? 0);
    this.tracer.restResponse?.({
      method: 'GET',
      path,
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: traceResponseHeaders(response.headers),
      durationMs: Date.now() - startedAt,
      code: envelope?.code ?? response.status,
      msg: envelope?.msg ?? response.statusText,
      envelopeRequestId: envelope?.request_id,
      details: envelope?.details,
    });
    throw new DaemonApiError({
      code: envelope?.code ?? response.status,
      msg: envelope?.msg ?? response.statusText,
      requestId: envelope?.request_id ?? requestId,
      details: envelope?.details,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }

  async post<T>(
    path: string,
    body?: unknown,
    opts?: DaemonRequestOptions,
  ): Promise<T> {
    return this.request<T>('POST', path, body, undefined, opts);
  }

  async postWithDetails<T>(
    path: string,
    body?: unknown,
    opts?: DaemonRequestOptions,
  ): Promise<DaemonEnvelope<T>> {
    return this.requestEnvelope<T>('POST', path, body, undefined, opts);
  }

  async postZip(
    path: string,
    body: unknown,
    traceBody: Record<string, number>,
  ): Promise<{ blob: Blob; contentDisposition?: string }> {
    const method = 'POST';
    const url = buildRestUrl(this.opts.origin, path);
    const requestId = createRequestId();
    const headers: Record<string, string> = {
      'X-Request-Id': requestId,
      'Content-Type': 'application/json; charset=utf-8',
    };
    this.addClientHeaders(headers);
    const startedAt = Date.now();
    this.tracer.restRequest?.({ method, path, url, requestId, headers: traceRequestHeaders(headers), body: traceBody });

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: timeoutSignal(EXPORT_TIMEOUT_MS),
      });
    } catch (error) {
      this.tracer.restFailure?.({
        method,
        path,
        requestId,
        phase: 'fetch',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw new DaemonNetworkError({
        message: `Network error calling ${method} ${path}`,
        cause: error,
        method,
        path,
        url,
        requestId,
        phase: 'fetch',
        timeoutMs: EXPORT_TIMEOUT_MS,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (!response.ok || mediaType !== 'application/zip') {
      let envelope: WireEnvelope<unknown> | undefined;
      try {
        envelope = (await response.clone().json()) as WireEnvelope<unknown>;
      } catch {}
      this.checkAuthRequired(response, envelope?.code ?? 0);
      if (!response.ok || (envelope !== undefined && envelope.code !== 0)) {
        const code = envelope?.code ?? response.status;
        const msg = envelope?.msg ?? response.statusText;
        this.tracer.restResponse?.({
          method,
          path,
          requestId,
          status: response.status,
          statusText: response.statusText,
          headers: traceResponseHeaders(response.headers),
          durationMs: Date.now() - startedAt,
          code,
          msg,
          envelopeRequestId: envelope?.request_id,
          details: envelope?.details,
        });
        throw new DaemonApiError({
          code,
          msg,
          requestId: envelope?.request_id ?? requestId,
          details: envelope?.details,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      }

      const bodyPreview = await readResponsePreview(response.clone());
      const error = new TypeError(`Expected application/zip, received ${contentType ?? 'no content type'}`);
      this.tracer.restFailure?.({
        method,
        path,
        requestId,
        phase: 'parse',
        durationMs: Date.now() - startedAt,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        bodyPreview,
        error,
      });
      throw new DaemonNetworkError({
        message: `Invalid ZIP response from ${method} ${path}`,
        cause: error,
        method,
        path,
        url,
        requestId,
        phase: 'parse',
        timeoutMs: EXPORT_TIMEOUT_MS,
        status: response.status,
        statusText: response.statusText,
        contentType,
        bodyPreview,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    let blob: Blob;
    try {
      blob = await response.blob();
    } catch (error) {
      this.tracer.restFailure?.({
        method,
        path,
        requestId,
        phase: 'parse',
        durationMs: Date.now() - startedAt,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        error,
      });
      throw new DaemonNetworkError({
        message: `Failed to read ZIP response from ${method} ${path}`,
        cause: error,
        method,
        path,
        url,
        requestId,
        phase: 'parse',
        timeoutMs: EXPORT_TIMEOUT_MS,
        status: response.status,
        statusText: response.statusText,
        contentType,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    this.tracer.restResponse?.({
      method,
      path,
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: traceResponseHeaders(response.headers),
      durationMs: Date.now() - startedAt,
      code: 0,
      msg: '',
    });
    return {
      blob,
      contentDisposition: response.headers.get('content-disposition') ?? undefined,
    };
  }

  async postForm<T>(path: string, formData: FormData, opts?: { onUploadProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }): Promise<T> {
    if (opts?.onUploadProgress !== undefined) return this.postFormXhr<T>(path, formData, opts.onUploadProgress, opts.signal);
    const url = buildRestUrl(this.opts.origin, path);
    const requestId = createRequestId();
    const headers: Record<string, string> = {
      'X-Request-Id': requestId,
    };
    this.addClientHeaders(headers);
    const startedAt = Date.now();
    this.tracer.restRequest?.({ method: 'POST', path, url, requestId, headers: traceRequestHeaders(headers), body: describeFormData(formData) });
    const callerSignal = opts?.signal;
    const timeout = timeoutSignal();
    const signal = callerSignal === undefined
      ? timeout
      : timeout === undefined
        ? callerSignal
        : AbortSignal.any([timeout, callerSignal]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal,
      });
    } catch (err) {
      this.tracer.restFailure?.({ method: 'POST', path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, error: err });
      throw new DaemonNetworkError({
        message: `Network error calling POST ${path}`,
        cause: err,
        method: 'POST',
        path,
        url,
        requestId,
        phase: 'fetch',
        timeoutMs: REQUEST_TIMEOUT_MS,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    let envelope: WireEnvelope<T>;
    const responseForDiagnostics = response.clone();
    try {
      envelope = (await response.json()) as WireEnvelope<T>;
    } catch (err) {
      const bodyPreview = await readResponsePreview(responseForDiagnostics);
      this.tracer.restFailure?.({
        method: 'POST',
        path,
        requestId,
        phase: 'parse',
        durationMs: Date.now() - startedAt,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        bodyPreview,
        error: err,
      });
      throw new DaemonNetworkError({
        message: `Failed to parse JSON response from POST ${path}`,
        cause: err,
        method: 'POST',
        path,
        url,
        requestId,
        phase: 'parse',
        timeoutMs: REQUEST_TIMEOUT_MS,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') ?? undefined,
        bodyPreview,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    this.tracer.restResponse?.({
      method: 'POST',
      path,
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: traceResponseHeaders(response.headers),
      durationMs: Date.now() - startedAt,
      code: envelope.code,
      msg: envelope.msg,
      envelopeRequestId: envelope.request_id,
      details: envelope.details,
      data: envelope.data,
    });
    this.checkAuthRequired(response, envelope.code);
    if (envelope.code !== 0) {
      const fallbackCode = (envelope as { code?: number }).code ?? response.status;
      throw new DaemonApiError({
        code: fallbackCode,
        msg: envelope.msg ?? response.statusText,
        requestId: envelope.request_id ?? requestId,
        details: envelope.details,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    return envelope.data as T;
  }

  private postFormXhr<T>(path: string, formData: FormData, onUploadProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<T> {
    const url = buildRestUrl(this.opts.origin, path);
    const requestId = createRequestId();
    const headers: Record<string, string> = { 'X-Request-Id': requestId };
    this.addClientHeaders(headers);
    const startedAt = Date.now();
    this.tracer.restRequest?.({ method: 'POST', path, url, requestId, headers: traceRequestHeaders(headers), body: describeFormData(formData) });
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = (): void => xhr.abort();
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      xhr.open('POST', url);
      xhr.timeout = REQUEST_TIMEOUT_MS;
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onUploadProgress(event.loaded, event.total);
      };
      xhr.onerror = () => {
        cleanup();
        this.tracer.restFailure?.({ method: 'POST', path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, error: xhr.statusText || 'network error' });
        reject(new DaemonNetworkError({
          message: `Network error calling POST ${path}`,
          cause: null,
          method: 'POST',
          path,
          url,
          requestId,
          phase: 'fetch',
          timeoutMs: REQUEST_TIMEOUT_MS,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        }));
      };
      xhr.ontimeout = () => {
        cleanup();
        this.tracer.restFailure?.({ method: 'POST', path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, error: 'timeout' });
        reject(new DaemonNetworkError({
          message: `Timeout calling POST ${path}`,
          cause: null,
          method: 'POST',
          path,
          url,
          requestId,
          phase: 'fetch',
          timeoutMs: REQUEST_TIMEOUT_MS,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        }));
      };
      xhr.onload = () => {
        cleanup();
        let envelope: WireEnvelope<T>;
        try {
          envelope = JSON.parse(xhr.responseText) as WireEnvelope<T>;
        } catch (err) {
          this.tracer.restFailure?.({
            method: 'POST',
            path,
            requestId,
            phase: 'parse',
            durationMs: Date.now() - startedAt,
            status: xhr.status,
            statusText: xhr.statusText,
            bodyPreview: xhr.responseText.slice(0, BODY_PREVIEW_LIMIT),
            error: err,
          });
          reject(new DaemonNetworkError({
            message: `Failed to parse JSON response from POST ${path}`,
            cause: err,
            method: 'POST',
            path,
            url,
            requestId,
            phase: 'parse',
            timeoutMs: REQUEST_TIMEOUT_MS,
            status: xhr.status,
            statusText: xhr.statusText,
            bodyPreview: xhr.responseText.slice(0, BODY_PREVIEW_LIMIT),
            timestamp: Date.now(),
            durationMs: Date.now() - startedAt,
          }));
          return;
        }
        this.tracer.restResponse?.({
          method: 'POST',
          path,
          requestId,
          status: xhr.status,
          statusText: xhr.statusText,
          durationMs: Date.now() - startedAt,
          code: envelope.code,
          msg: envelope.msg,
          envelopeRequestId: envelope.request_id,
          details: envelope.details,
          data: envelope.data,
        });
        this.checkAuthStatus(xhr.status, envelope.code);
        if (envelope.code !== 0) {
          const fallbackCode = (envelope as { code?: number }).code ?? xhr.status;
          reject(new DaemonApiError({
            code: fallbackCode,
            msg: envelope.msg ?? xhr.statusText,
            requestId: envelope.request_id ?? requestId,
            details: envelope.details,
            timestamp: Date.now(),
            durationMs: Date.now() - startedAt,
          }));
          return;
        }
        resolve(envelope.data as T);
      };
      const rejectAborted = (): void => {
        cleanup();
        this.tracer.restAbort?.({ method: 'POST', path, requestId, durationMs: Date.now() - startedAt });
        reject(new DOMException('Upload aborted', 'AbortError'));
      };
      xhr.onabort = rejectAborted;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted === true) {
        rejectAborted();
        return;
      }
      xhr.send(formData);
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: RestQuery,
    opts: DaemonRequestOptions = {},
  ): Promise<T> {
    return (await this.requestEnvelope<T>(method, path, body, query, opts)).data;
  }

  private async requestEnvelope<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: RestQuery,
    opts: DaemonRequestOptions = {},
  ): Promise<DaemonEnvelope<T>> {
    const allowCodes = opts.allowCodes ?? [];
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const callerSignal = opts.signal;
    let url = buildRestUrl(this.opts.origin, path);
    if (query) {
      const params = new URLSearchParams();
      appendQuery(params, query);
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }

    this.backgroundRequests.assertOpen();
    const queuedAt = Date.now();
    const release = opts.background === true
      ? await this.backgroundRequests.acquire(callerSignal)
      : undefined;
    try {
      this.backgroundRequests.assertOpen();
      if (opts.background === true) callerSignal?.throwIfAborted();
      const queueMs = opts.background === true ? Date.now() - queuedAt : undefined;
      const requestId = createRequestId();
      const headers: Record<string, string> = {
        'X-Request-Id': requestId,
      };
      this.addClientHeaders(headers);
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }

      const startedAt = Date.now();
      this.tracer.restRequest?.({ method, path, url, requestId, headers: traceRequestHeaders(headers), body, queueMs });

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: callerSignal !== undefined ? combinedSignal(timeoutMs, callerSignal) : timeoutSignal(timeoutMs),
        });
      } catch (err) {
        if (callerSignal?.aborted && err instanceof Error && err.name === 'AbortError') {
          this.tracer.restAbort?.({ method, path, requestId, durationMs: Date.now() - startedAt, queueMs });
          throw err;
        }
        this.tracer.restFailure?.({ method, path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, queueMs, error: err });
        throw new DaemonNetworkError({
          message: `Network error calling ${method} ${path}`,
          cause: err,
          method,
          path,
          url,
          requestId,
          phase: 'fetch',
          timeoutMs,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      }

      let envelope: WireEnvelope<T>;
      const responseForDiagnostics = response.clone();
      try {
        const text = await response.text();
        envelope = (
          response.status === 204 && text === ''
            ? { code: 0, msg: '', data: null, request_id: requestId }
            : JSON.parse(text)
        ) as WireEnvelope<T>;
      } catch (err) {
        if (callerSignal?.aborted && err instanceof Error && err.name === 'AbortError') {
          this.tracer.restAbort?.({ method, path, requestId, durationMs: Date.now() - startedAt, queueMs });
          throw err;
        }
        const bodyPreview = await readResponsePreview(responseForDiagnostics);
        this.tracer.restFailure?.({
          method,
          path,
          requestId,
          phase: 'parse',
          durationMs: Date.now() - startedAt,
          queueMs,
          status: response.status,
          statusText: response.statusText,
          headers: traceResponseHeaders(response.headers),
          bodyPreview,
          error: err,
        });
        throw new DaemonNetworkError({
          message: `Failed to parse JSON response from ${method} ${path}`,
          cause: err,
          method,
          path,
          url,
          requestId,
          phase: 'parse',
          timeoutMs,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get('content-type') ?? undefined,
          bodyPreview,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      }

      this.tracer.restResponse?.({
        method,
        path,
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: traceResponseHeaders(response.headers),
        durationMs: Date.now() - startedAt,
        queueMs,
        code: envelope.code,
        msg: envelope.msg,
        envelopeRequestId: envelope.request_id,
        details: envelope.details,
        data: envelope.data,
      });

      this.checkAuthRequired(response, envelope.code);

      if (envelope.code !== 0 && !allowCodes.includes(envelope.code)) {
        throw new DaemonApiError({
          code: typeof envelope.code === 'number' ? envelope.code : response.status,
          msg:
            typeof envelope.msg === 'string' && envelope.msg.length > 0
              ? envelope.msg
              : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
          requestId: envelope.request_id ?? requestId,
          details: envelope.details,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      }

      return { data: envelope.data as T, details: envelope.details };
    } finally {
      release?.();
    }
  }

  private addClientHeaders(headers: Record<string, string>): void {
    const token = this.opts.credentialStore?.getToken();
    if (token !== undefined) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const identity = this.opts.identity;
    if (identity !== undefined) {
      headers['X-Kimi-Client-Id'] = identity.clientId;
      headers['X-Kimi-Client-Name'] = identity.clientName;
      headers['X-Kimi-Client-Version'] = identity.clientVersion;
      headers['X-Kimi-Client-Ui-Mode'] = identity.clientUiMode;
    }
  }

  private checkAuthRequired(response: Response, envelopeCode: number): void {
    this.checkAuthStatus(response.status, envelopeCode);
  }

  private checkAuthStatus(status: number, envelopeCode: number): void {
    if (status === 401 || envelopeCode === SERVER_AUTH_UNAUTHORIZED_CODE) {
      this.opts.credentialStore?.markAuthRequired?.();
    }
  }
}
