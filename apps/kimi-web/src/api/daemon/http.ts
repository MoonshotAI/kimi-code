// apps/kimi-web/src/api/daemon/http.ts
// DaemonHttpClient — REST transport with envelope unwrap and allowCodes support.

import { buildRestUrl } from '../config';
import { DaemonApiError, DaemonNetworkError } from '../errors';
import { traceRestFailure, traceRestRequest, traceRestResponse } from '../../debug/trace';
import { getCredential, markAuthRequired } from './serverAuth';
import type { WireEnvelope } from './wire';

/** Per-request timeout. Without one, a hung connection (half-open TCP after a
    network change, stuck daemon) leaves promises pending for minutes — and the
    composer's in-flight flag with them. Generous enough for slow endpoints;
    streaming runs over the WS, not these REST calls. */
const REQUEST_TIMEOUT_MS = 30_000;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_PREVIEW_LIMIT = 500;

// Server-transport auth failure envelope code (see packages/server
// middleware/auth.ts AUTH_ERROR_CODE). Distinct from provider-auth 40110–40113.
const SERVER_AUTH_UNAUTHORIZED_CODE = 40101;

export interface DaemonHttpClientIdentity {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly clientUiMode: string;
}

/** AbortSignal.timeout with a fallback for older environments (jsdom). */
function timeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  } catch {
    return undefined;
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

/** Trace-only FormData summary: field names + file name/size/type, never content. */
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

export class DaemonHttpClient {
  constructor(
    private readonly origin: string,
    private readonly identity?: DaemonHttpClientIdentity,
  ) {}

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, body?: unknown, opts?: { allowCodes?: number[] }): Promise<T> {
    return this.request<T>('POST', path, body, undefined, opts?.allowCodes);
  }

  /** Send multipart/form-data (FormData). Does NOT set Content-Type — browser sets it with boundary. */
  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const url = buildRestUrl(this.origin, path);
    const requestId = createRequestId();
    const headers: Record<string, string> = {
      'X-Request-Id': requestId,
    };
    this.addClientHeaders(headers);
    const startedAt = Date.now();
    traceRestRequest({ method: 'POST', path, url, requestId, body: describeFormData(formData) });
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: formData, signal: timeoutSignal() });
    } catch (err) {
      traceRestFailure({ method: 'POST', path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, error: err });
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
      traceRestFailure({ method: 'POST', path, requestId, phase: 'parse', durationMs: Date.now() - startedAt, status: response.status, error: err });
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
        bodyPreview: await readResponsePreview(responseForDiagnostics),
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    traceRestResponse({
      method: 'POST',
      path,
      requestId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      code: envelope.code,
      msg: envelope.msg,
      envelopeRequestId: envelope.request_id,
      data: envelope.data,
    });
    this.checkAuthRequired(response, envelope.code);
    if (envelope.code !== 0) {
      throw new DaemonApiError({
        code: envelope.code,
        msg: envelope.msg,
        requestId: envelope.request_id,
        details: envelope.details,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
    return envelope.data as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    allowCodes: number[] = [],
  ): Promise<T> {
    // Build URL, appending query string (omit undefined values)
    let url = buildRestUrl(this.origin, path);
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }

    // Build headers
    const requestId = createRequestId();
    const headers: Record<string, string> = {
      'X-Request-Id': requestId,
    };
    this.addClientHeaders(headers);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    const startedAt = Date.now();
    traceRestRequest({ method, path, url, requestId, body });

    // Execute fetch
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(),
      });
    } catch (err) {
      traceRestFailure({ method, path, requestId, phase: 'fetch', durationMs: Date.now() - startedAt, error: err });
      throw new DaemonNetworkError({
        message: `Network error calling ${method} ${path}`,
        cause: err,
        method,
        path,
        url,
        requestId,
        phase: 'fetch',
        timeoutMs: REQUEST_TIMEOUT_MS,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    // Parse envelope
    let envelope: WireEnvelope<T>;
    const responseForDiagnostics = response.clone();
    try {
      envelope = (await response.json()) as WireEnvelope<T>;
    } catch (err) {
      traceRestFailure({ method, path, requestId, phase: 'parse', durationMs: Date.now() - startedAt, status: response.status, error: err });
      throw new DaemonNetworkError({
        message: `Failed to parse JSON response from ${method} ${path}`,
        cause: err,
        method,
        path,
        url,
        requestId,
        phase: 'parse',
        timeoutMs: REQUEST_TIMEOUT_MS,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') ?? undefined,
        bodyPreview: await readResponsePreview(responseForDiagnostics),
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    traceRestResponse({
      method,
      path,
      requestId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      code: envelope.code,
      msg: envelope.msg,
      envelopeRequestId: envelope.request_id,
      data: envelope.data,
    });

    this.checkAuthRequired(response, envelope.code);

    // Unwrap: code 0 = success; allowed non-zero = return data; else throw
    if (envelope.code !== 0 && !allowCodes.includes(envelope.code)) {
      throw new DaemonApiError({
        code: envelope.code,
        msg: envelope.msg,
        requestId: envelope.request_id,
        details: envelope.details,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    // For both code=0 and allowed non-zero codes, return the data field.
    // Callers that pass allowCodes handle the null/non-null data themselves.
    return envelope.data as T;
  }

  private addClientHeaders(headers: Record<string, string>): void {
    const credential = getCredential();
    if (credential !== undefined) {
      headers['Authorization'] = `Bearer ${credential}`;
    }
    if (this.identity === undefined) return;
    headers['X-Kimi-Client-Id'] = this.identity.clientId;
    headers['X-Kimi-Client-Name'] = this.identity.clientName;
    headers['X-Kimi-Client-Version'] = this.identity.clientVersion;
    headers['X-Kimi-Client-Ui-Mode'] = this.identity.clientUiMode;
  }

  private checkAuthRequired(response: Response, envelopeCode: number): void {
    if (
      response.status === 401 ||
      envelopeCode === SERVER_AUTH_UNAUTHORIZED_CODE
    ) {
      markAuthRequired();
    }
  }
}
