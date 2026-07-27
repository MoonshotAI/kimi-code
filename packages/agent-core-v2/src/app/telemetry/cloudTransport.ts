/**
 * `telemetry` domain (L1) — `CloudTransport`, the HTTP transport behind
 * `CloudAppender`. Posts enriched events to the telemetry endpoint with Bearer
 * auth, retry, and a byte-store fallback for failed events, persisted through
 * the `storage` byte layer (`IFileSystemStorageService`) under the `telemetry` scope.
 * App-scoped; independent of `@moonshot-ai/kimi-telemetry`.
 */

import { randomBytes } from 'node:crypto';

import { isAbortError } from '#/_base/utils/abort';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export type CloudPrimitive = boolean | number | string | undefined | null;

export type CloudProperties = Record<string, CloudPrimitive>;

export type CloudContext = Record<string, CloudPrimitive>;

export interface CloudEvent {
  readonly event_id: string;
  device_id: string | null;
  session_id: string | null;
  readonly event: string;
  readonly timestamp: number;
  readonly properties: CloudProperties;
}

export interface EnrichedCloudEvent extends CloudEvent {
  readonly context: CloudContext;
}

export interface CloudPayload {
  readonly user_id: string;
  readonly events: readonly Record<string, CloudPrimitive>[];
}

export interface CloudTransportOptions {
  readonly storage: IFileSystemStorageService;
  readonly deviceId: string;
  readonly endpoint?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export const TELEMETRY_ENDPOINT = 'https://telemetry-logs.kimi.com/v1/event';
export const SERVER_EVENT_PREFIX = 'kfc_';
export const USER_ID_PREFIX = 'kfc_device_id_';
export const DISK_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TELEMETRY_SCOPE = 'telemetry';
const FAILED_PREFIX = 'failed_';
const JSONL_SUFFIX = '.jsonl';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class CloudTransport {
  private readonly storage: IFileSystemStorageService;
  private readonly deviceId: string;
  private readonly endpoint: string;
  private readonly getAccessToken: (() => string | null | Promise<string | null>) | null;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffsMs: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: CloudTransportOptions) {
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.endpoint = options.endpoint ?? TELEMETRY_ENDPOINT;
    this.getAccessToken = options.getAccessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffsMs = options.retryBackoffsMs ?? RETRY_BACKOFFS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleepImpl = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  async send(events: readonly EnrichedCloudEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return;
    let savedToDisk = false;
    const saveEventsToDisk = async (): Promise<void> => {
      if (savedToDisk) return;
      await this.saveToDisk(events);
      savedToDisk = true;
    };
    if (signal?.aborted === true) {
      await saveEventsToDisk();
      throw abortError();
    }

    let payload: CloudPayload;
    try {
      payload = buildPayload(events, this.deviceId);
    } catch {
      return;
    }

    try {
      for (let attempt = 0; attempt <= this.retryBackoffsMs.length; attempt++) {
        try {
          await this.sendHttp(payload, signal);
          return;
        } catch (error) {
          if (isSignalAborted(signal) || isAbortError(error)) {
            await saveEventsToDisk();
            throw error;
          }
          if (!(error instanceof TransientCloudError)) {
            break;
          }
          const backoff = this.retryBackoffsMs[attempt];
          if (backoff === undefined) break;
          await this.sleepImpl(backoff, signal);
        }
      }
    } catch (error) {
      if (isSignalAborted(signal) || isAbortError(error)) {
        await saveEventsToDisk();
        throw error;
      }
    }

    await saveEventsToDisk();
  }

  async saveToDisk(events: readonly EnrichedCloudEvent[]): Promise<void> {
    if (events.length === 0) return;
    const key = `${FAILED_PREFIX}${this.now()}_${randomBytes(6).toString('hex')}${JSONL_SUFFIX}`;
    const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    await this.storage.write(TELEMETRY_SCOPE, key, textEncoder.encode(text));
  }

  async retryDiskEvents(): Promise<void> {
    const keys = await this.storage.list(TELEMETRY_SCOPE, FAILED_PREFIX);
    const now = this.now();
    for (const key of keys) {
      if (!key.startsWith(FAILED_PREFIX) || !key.endsWith(JSONL_SUFFIX)) continue;
      const createdAt = parseFailedTimestamp(key);
      if (createdAt === undefined || now - createdAt > DISK_EVENT_MAX_AGE_MS) {
        await this.storage.delete(TELEMETRY_SCOPE, key).catch(() => undefined);
        continue;
      }

      let events: EnrichedCloudEvent[];
      let payload: CloudPayload;
      try {
        events = await this.readJsonl(key);
        payload = buildPayload(events, this.deviceId);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          await this.storage.delete(TELEMETRY_SCOPE, key).catch(() => undefined);
        }
        continue;
      }

      try {
        await this.sendHttp(payload);
        await this.storage.delete(TELEMETRY_SCOPE, key);
      } catch (error) {
        if (error instanceof TransientCloudError) continue;
      }
    }
  }

  private async readJsonl(key: string): Promise<EnrichedCloudEvent[]> {
    const bytes = await this.storage.read(TELEMETRY_SCOPE, key);
    if (bytes === undefined) return [];
    const text = textDecoder.decode(bytes);
    const events: EnrichedCloudEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      events.push(JSON.parse(trimmed) as EnrichedCloudEvent);
    }
    return events;
  }

  private async sendHttp(payload: CloudPayload, signal?: AbortSignal): Promise<void> {
    const token = this.getAccessToken === null ? null : await this.getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token !== null && token.length > 0) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await this.post(payload, headers, signal);
    if (response.status === 401 && headers['Authorization'] !== undefined) {
      delete headers['Authorization'];
      const retry = await this.post(payload, headers, signal);
      handleStatus(retry.status);
      return;
    }
    handleStatus(response.status);
  }

  private async post(
    payload: CloudPayload,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(
        this.fetchImpl,
        this.endpoint,
        {
          method: 'POST',
          headers: { ...headers },
          body: JSON.stringify(payload),
        },
        this.requestTimeoutMs,
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      throw new TransientCloudError(String(error));
    }
  }
}

function parseFailedTimestamp(key: string): number | undefined {
  const rest = key.slice(FAILED_PREFIX.length);
  const underscore = rest.indexOf('_');
  if (underscore === -1) return undefined;
  const raw = rest.slice(0, underscore);
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : undefined;
}

export class TransientCloudError extends Error {
  override readonly name = 'TransientCloudError';
}

export function buildUserId(deviceId: string): string {
  return USER_ID_PREFIX + deviceId;
}

export function buildPayload(
  events: readonly EnrichedCloudEvent[],
  deviceId: string,
): CloudPayload {
  return {
    user_id: buildUserId(deviceId),
    events: events.map((event) => flattenEvent(applyServerPrefix(event))),
  };
}

export function applyServerPrefix(event: EnrichedCloudEvent): EnrichedCloudEvent {
  const name: unknown = event.event;
  if (typeof name !== 'string' || name.length === 0 || name.startsWith(SERVER_EVENT_PREFIX)) {
    return event;
  }
  return { ...event, event: SERVER_EVENT_PREFIX + name };
}

export function flattenEvent(event: EnrichedCloudEvent): Record<string, CloudPrimitive> {
  const out: Record<string, CloudPrimitive> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'properties') {
      flattenNested(out, 'property', value);
    } else if (key === 'context') {
      flattenNested(out, 'context', value);
    } else {
      assertPrimitive(key, value);
      out[key] = value;
    }
  }
  return out;
}

export function isCloudPrimitive(value: unknown): value is CloudPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}

function flattenNested(target: Record<string, CloudPrimitive>, prefix: string, value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    assertPrimitive(`${prefix}.${key}`, nestedValue);
    target[`${prefix}_${key}`] = nestedValue;
  }
}

function assertPrimitive(key: string, value: unknown): asserts value is CloudPrimitive {
  if (isCloudPrimitive(value)) return;
  throw new TypeError(`telemetry ${key} must be primitive`);
}

function handleStatus(status: number): void {
  if (status >= 500 || status === 429) {
    throw new TransientCloudError(`HTTP ${String(status)}`);
  }
  if (status >= 400) {
    return;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    controller.abort(new Error('telemetry request timed out'));
  }, timeoutMs);
  timeout.unref?.();
  if (externalSignal?.aborted === true) abortFromExternal();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
