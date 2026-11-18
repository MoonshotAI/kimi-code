import { once } from 'node:events';
import type { Duplex } from 'node:stream';

export const HOST_STREAM_CHUNK_BYTES = 256 * 1024;
export const HOST_STREAM_BUFFER_BYTES = 1024 * 1024;
export const HOST_STREAM_MAX_CONCURRENT = 4;
export const HOST_STREAM_MAX_BODY_BYTES = 500 * 1024 * 1024;
export const HOST_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const HOST_STREAM_TOTAL_TIMEOUT_MS = 60 * 60_000;

export interface HostStreamPolicy {
  readonly maxBodyBytes: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

const policy: HostStreamPolicy = {
  maxBodyBytes: HOST_STREAM_MAX_BODY_BYTES,
  idleTimeoutMs: HOST_STREAM_IDLE_TIMEOUT_MS,
  totalTimeoutMs: HOST_STREAM_TOTAL_TIMEOUT_MS,
};

export function hostStreamPolicy(path: string): HostStreamPolicy | undefined {
  const attachment = /^\/api\/v1\/feedback\/[^/]+\/attachments(?:\?|$)/.test(path);
  const feedbackPackage = /^\/api\/v1\/sessions\/[^/]+\/feedback_package(?:\?|$)/.test(path);
  return attachment || feedbackPackage ? policy : undefined;
}

export class HostStreamStopped extends Error {
  constructor() {
    super('host stream stopped');
    this.name = 'HostStreamStopped';
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new HostStreamStopped();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new HostStreamStopped());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function waitStreamDrain(stream: Duplex, signal: AbortSignal): Promise<void> {
  await once(stream, 'drain', { signal });
}
