import type { TraceRendererError } from '@moonshot-ai/app-client/trace';
import { track } from '../lib/track';
import { errorSignature, signatureOf, type ErrorSignature } from '../../shared/error-signature';

const RENDERER_ERROR_WINDOW_MS = 60_000;
const rendererErrorLastSent = new Map<string, number>();
const BENIGN_WINDOW_ERROR = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

type RendererErrorSource = TraceRendererError['source'];

let rendererPhase: 'boot' | 'running' = 'boot';

export function markRendererRunning(): void {
  rendererPhase = 'running';
}

export function isBenignWindowError(e: ErrorEvent): boolean {
  return !(e.error instanceof Error) && BENIGN_WINDOW_ERROR.test(e.message);
}

export function reportRendererError(error: TraceRendererError): void {
  switch (error.source) {
    case 'vue':
      trackRendererError(error.errorClass, 'vue', signatureOf(error.error));
      return;
    case 'window': {
      const e = error.event;
      const stack =
        e.error instanceof Error ? e.error.stack : `${error.errorClass}: ${e.message}\n    at ${e.filename}:${e.lineno}:${e.colno}`;
      trackRendererError(error.errorClass, 'window', errorSignature(error.errorClass, e.message, stack));
      return;
    }
    case 'rejection':
      trackRendererError(rejectionErrorClass(error.reason), 'rejection', signatureOf(error.reason));
  }
}

function trackRendererError(errorClass: string, source: RendererErrorSource, signature: ErrorSignature): void {
  const now = Date.now();
  const last = rendererErrorLastSent.get(signature.fingerprint);
  if (last !== undefined && now - last < RENDERER_ERROR_WINDOW_MS) return;
  rendererErrorLastSent.set(signature.fingerprint, now);
  track('renderer_error', {
    error_class: errorClass,
    source,
    fingerprint: signature.fingerprint,
    top_frame: signature.topFrame ?? undefined,
    phase: rendererPhase,
  });
}

function rejectionErrorClass(reason: unknown): string {
  if (reason instanceof Error) return reason.name;
  try {
    const name = (reason as { constructor?: { name?: string } } | null)?.constructor?.name;
    return typeof name === 'string' && name !== '' ? name : 'Unknown';
  } catch {
    return 'Unknown';
  }
}
