import { DaemonApiError, DaemonNetworkError } from '@moonshot-ai/app-core/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rendererTrackEventSchema } from '../../src/shared/track-events';
import { classifyFeedbackClientError, trackFeedbackMediaValidation } from '../../src/renderer/lib/feedbackTelemetry';

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../src/renderer/lib/track', () => ({ track }));

afterEach(() => {
  vi.resetAllMocks();
});

function networkError(input: Partial<ConstructorParameters<typeof DaemonNetworkError>[0]> = {}): DaemonNetworkError {
  return new DaemonNetworkError({
    message: 'POST http://127.0.0.1:1234/api/v1/feedback/1/attachments/session failed',
    cause: new TypeError('fetch failed'),
    method: 'POST',
    path: '/feedback/1/attachments/session',
    url: 'http://127.0.0.1:1234/api/v1/feedback/1/attachments/session',
    requestId: 'req',
    phase: 'fetch',
    timeoutMs: Infinity,
    ...input,
  });
}

describe('feedback client telemetry classification', () => {
  it('classifies daemon API, network, timeout, and abort failures without raw messages', () => {
    const api = (code: number) => new DaemonApiError({ code, msg: 'Secret /Users/alice prompt', requestId: 'req' });
    expect(classifyFeedbackClientError(api(40111))).toEqual({ error_class: 'auth_required', error_code: '40111' });
    expect(classifyFeedbackClientError(api(40112))).toEqual({ error_class: 'access_denied', error_code: '40112' });
    expect(classifyFeedbackClientError(api(41301))).toEqual({ error_class: 'file_too_large', error_code: '41301' });
    expect(classifyFeedbackClientError(api(40401))).toEqual({ error_class: 'session_not_found', error_code: '40401' });
    expect(classifyFeedbackClientError(api(40936))).toEqual({ error_class: 'feedback_rejected', error_code: '40936' });
    expect(classifyFeedbackClientError(api(50001))).toEqual({ error_class: 'api', error_code: '50001' });
    expect(classifyFeedbackClientError(networkError({ status: 503 }))).toEqual({ error_class: 'network', http_status: 503 });
    expect(classifyFeedbackClientError(networkError({ cause: new DOMException('timed out', 'TimeoutError') }))).toEqual({ error_class: 'timeout' });
    expect(classifyFeedbackClientError(new DOMException('cancelled', 'AbortError'))).toEqual({ error_class: 'aborted' });
    const controller = new AbortController();
    controller.abort();
    expect(classifyFeedbackClientError(new Error('late failure'), controller.signal)).toEqual({ error_class: 'aborted' });
    const unknown = classifyFeedbackClientError(new Error('Bearer sk-secret /Users/alice/private'));
    expect(unknown).toEqual({ error_class: 'unknown' });
    expect(JSON.stringify(unknown)).not.toContain('sk-secret');
  });

  it('reports frontend media validation rejections using schema-valid events', () => {
    const size = 11 * 1024 * 1024;
    const file = new File([new Uint8Array(size)], 'private-name.png', { type: 'image/png' });
    const files = { 0: file, length: 1, item: () => file, [Symbol.iterator]: [file][Symbol.iterator] } as unknown as FileList;
    trackFeedbackMediaValidation(['feedback.imageSize', 'feedback.mediaType'], files, 'session-1');
    expect(track).toHaveBeenCalledTimes(2);
    for (const [event, properties] of track.mock.calls) {
      const parsed = rendererTrackEventSchema.safeParse({ event, properties });
      expect(parsed.success).toBe(true);
      expect(properties).toMatchObject({
        emitter: 'client', attachment_kind: 'media', stage: 'validation', outcome: 'validation_rejected',
        attempt: 'initial', session_id: 'session-1', media_kind: 'image', size_bytes: size,
      });
      expect(JSON.stringify(properties)).not.toContain('private-name.png');
    }
    expect(track.mock.calls.map(([, properties]) => properties.error_class)).toEqual(['file_too_large', 'invalid_type']);
  });
});
