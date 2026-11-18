import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import {
  clearTrace,
  configureTrace,
  installClientErrorCapture,
  isTraceEnabled,
  reportRendererException,
  rejectionText,
  sessionExportTraceToJsonl,
  setTraceEnabled,
  traceClientEvent,
  traceEntries,
  traceHttpExchange,
  traceKeyEvent,
  tracePaused,
  traceRawJson,
  traceRestAbort,
  traceRestFailure,
  traceRestRequest,
  traceRestResponse,
  traceToJsonl,
  traceVersion,
  traceWsIn,
} from '@moonshot-ai/app-client/trace';
import { isBenignWindowError, markRendererRunning, reportRendererError } from '../../src/renderer/debug/rendererErrors';

configureTrace({
  logPrefix: '[kimi-code]',
  logFilePrefix: 'kimi-code-log',
  ignoreWindowError: isBenignWindowError,
  onRendererError: reportRendererError,
});

describe('rejectionText', () => {
  it('uses the error message for Error reasons', () => {
    expect(rejectionText(new Error('boom'))).toBe('boom');
  });

  it('stringifies plain reasons', () => {
    expect(rejectionText('nope')).toBe('nope');
    expect(rejectionText(42)).toBe('42');
  });

  it('falls back to a placeholder for unstringifiable reasons', () => {
    expect(rejectionText(Object.create(null))).toBe('[unstringifiable reason]');
  });
});

describe('debug mode toggle', () => {
  afterEach(() => {
    setTraceEnabled(false);
    clearTrace();
  });

  it('records only while enabled and drops debug entries when disabled', () => {
    traceClientEvent('before');
    expect(traceEntries()).toHaveLength(0);

    setTraceEnabled(true);
    expect(isTraceEnabled()).toBe(true);
    traceClientEvent('during');
    traceKeyEvent('ws:connection', { status: 'connected' });
    expect(traceEntries().map((e) => e.kind)).toEqual(['client:event', 'client:key']);

    setTraceEnabled(false);
    expect(isTraceEnabled()).toBe(false);
    expect(traceEntries()).toHaveLength(0);
    expect(JSON.parse(sessionExportTraceToJsonl())).toMatchObject({ event: 'ws:connection' });
    traceClientEvent('after');
    expect(traceEntries()).toHaveLength(0);
  });

  it('keeps the unsanitized frame in memory while exports stay sanitized', () => {
    setTraceEnabled(true);
    const output = 'x'.repeat(2000);
    traceWsIn({
      type: 'transcript.ops',
      session_id: 'sess_1',
      payload: { seq: 7, agent_id: 'main', token: 'secret-value', output },
    });

    const [entry] = traceEntries();
    expect(entry).toMatchObject({ sessionId: 'sess_1', agentId: 'main', seq: 7 });
    expect(JSON.parse(traceRawJson(entry!.id)!)).toMatchObject({
      payload: { token: 'secret-value', output },
    });
    const jsonl = traceToJsonl();
    expect(jsonl).not.toContain('secret-value');
    expect(jsonl).not.toContain(output);
  });

  it('summarizes flat task, output, interaction and response frames in their labels', () => {
    setTraceEnabled(true);
    traceWsIn({
      type: 'task',
      session_id: 'sess_1',
      agent_id: 'main',
      task_id: 'bash-k3f9x2ab',
      kind: 'shell',
      status: 'ended',
      outcome: 'failed',
      description: 'npm run dev',
    });
    traceWsIn({ type: 'task', session_id: 'sess_1', agent_id: 'main', task_id: 'bash-1', kind: 'shell', status: 'running' });
    traceWsIn({ type: 'task.output', session_id: 'sess_1', agent_id: 'main', task_id: 'bash-1', offset: 13, text: 'héllo' });
    traceWsIn({
      type: 'interaction',
      session_id: 'sess_1',
      agent_id: 'main',
      interaction_id: 'int-1',
      kind: 'approval',
      status: 'pending',
    });
    traceWsIn({ type: 'response', request_id: 'r12', code: 40406, msg: 'task not found' });

    expect(traceEntries().map((e) => e.label)).toEqual([
      '← task (main bash-k3f9x2ab shell ended/failed "npm run dev")',
      '← task (main bash-1 shell running)',
      '← task.output (main bash-1 @13 +6B)',
      '← interaction (main approval pending int-1)',
      '← response (r12 code=40406 "task not found")',
    ]);
    expect(traceEntries()[0]).toMatchObject({ sessionId: 'sess_1', agentId: 'main' });
  });

  it('retains more entries for inspection than the export keeps', () => {
    setTraceEnabled(true);
    for (let index = 0; index < 600; index++) {
      traceClientEvent(`event-${index}`, { pad: 'x.'.repeat(240) });
    }

    expect(traceEntries()).toHaveLength(600);
    const jsonl = traceToJsonl();
    const lines = jsonl.split('\n');
    expect(lines.length).toBeLessThan(500);
    expect(new TextEncoder().encode(jsonl).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ label: '· event-599' });
  });

  it('records repeated console output once and publishes updates after the caller returns', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTraceEnabled(true);
    const dispose = installClientErrorCapture();
    try {
      const version = traceVersion.value;
      console.warn('render warning');
      console.warn('render warning');
      console.warn('another warning');

      expect(traceEntries().map((e) => e.label)).toEqual(['⚠ render warning', '⚠ another warning']);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(traceVersion.value).toBe(version);
      vi.advanceTimersByTime(100);
      expect(traceVersion.value).toBe(version + 1);
    } finally {
      dispose();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('REST queue timing', () => {
  beforeEach(() => {
    setTraceEnabled(true);
    tracePaused.value = false;
    clearTrace();
  });

  afterEach(() => {
    setTraceEnabled(false);
    clearTrace();
  });

  it('keeps queue wait in existing request, response and failure entries without duplicating response data', () => {
    traceRestRequest({
      method: 'GET', path: '/goal', url: 'http://test/goal', requestId: 'queued', queueMs: 125,
    });
    traceRestResponse({
      method: 'GET', path: '/goal', requestId: 'queued', status: 200, durationMs: 20,
      code: 0, msg: '', queueMs: 125,
      data: { result: 'unique-response-marker', output: 'large output '.repeat(1000), token: 'secret-value' },
    });
    traceRestFailure({
      method: 'GET', path: '/tasks', requestId: 'failed', phase: 'fetch', durationMs: 30,
      queueMs: 250, error: new Error('failed'),
    });

    expect(traceEntries()).toHaveLength(3);
    expect(traceEntries()).toMatchObject([
      { kind: 'rest:request', detail: { queueMs: 125 } },
      { kind: 'rest:response', durationMs: 20, detail: { queueMs: 125 } },
      { kind: 'rest:error', durationMs: 30, detail: { queueMs: 250 } },
    ]);
    const jsonl = traceToJsonl();
    expect(jsonl.match(/unique-response-marker/g)).toHaveLength(1);
    expect(jsonl).not.toContain('secret-value');
    expect(jsonl.length).toBeLessThan(2500);
    expect(JSON.parse(jsonl.split('\n')[1]!)).toMatchObject({ durationMs: 20, detail: { queueMs: 125 } });
  });

  it('preserves zero queue wait and leaves foreground queue timing absent in serialized traces', () => {
    traceRestRequest({
      method: 'GET', path: '/goal', url: 'http://test/goal', requestId: 'immediate', queueMs: 0,
    });
    traceRestResponse({
      method: 'GET', path: '/transcript', requestId: 'foreground', status: 200, durationMs: 10,
      code: 0, msg: '',
    });
    const [background, foreground] = traceToJsonl().split('\n').map((line) => JSON.parse(line));
    expect(background).toMatchObject({ detail: { queueMs: 0 } });
    expect(foreground.detail).not.toHaveProperty('queueMs');
    expect(foreground.durationMs).toBe(10);
  });
});

describe('HTTP exchange', () => {
  beforeEach(() => {
    setTraceEnabled(true);
    tracePaused.value = false;
    clearTrace();
  });

  afterEach(() => {
    setTraceEnabled(false);
    clearTrace();
  });

  it('pairs a request with its response by request id', () => {
    traceRestRequest({
      method: 'POST', path: '/sessions', url: 'http://test/api/v1/sessions?limit=5', requestId: 'req_1',
      headers: { 'X-Request-Id': 'req_1' }, body: { title: 'hello' }, queueMs: 40,
    });
    expect(traceHttpExchange('req_1')).toMatchObject({ method: 'POST', path: '/sessions', queueMs: 40, endedAt: undefined });

    traceRestResponse({
      method: 'POST', path: '/sessions', requestId: 'req_1', status: 404, statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }, durationMs: 12,
      code: 40401, msg: 'session not found', envelopeRequestId: 'req_1', details: { field: 'id' }, data: null,
    });
    const exchange = traceHttpExchange('req_1');
    expect(exchange.endedAt).toBeGreaterThanOrEqual(exchange.sentAt!);
    expect(exchange).toMatchObject({
      url: 'http://test/api/v1/sessions?limit=5',
      status: 404,
      statusText: 'Not Found',
      code: 40401,
      msg: 'session not found',
      durationMs: 12,
      queueMs: 40,
      cancelled: false,
      requestHeaders: { 'X-Request-Id': 'req_1' },
      requestBody: { title: 'hello' },
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { code: 40401, msg: 'session not found', request_id: 'req_1', details: { field: 'id' }, data: null },
      failure: undefined,
    });
  });

  it('attributes session-scoped requests to their session', () => {
    traceRestRequest({ method: 'GET', path: '/sessions/s1/status', url: 'http://test/api/v1/sessions/s1/status', requestId: 'req_3' });
    traceRestRequest({ method: 'GET', path: '/sessions?limit=5', url: 'http://test/api/v1/sessions?limit=5', requestId: 'req_4' });

    expect(traceEntries().map((entry) => entry.sessionId)).toEqual(['s1', undefined]);
  });

  it('marks a request cancelled by the caller', () => {
    traceRestRequest({ method: 'GET', path: '/tasks', url: 'http://test/api/v1/tasks', requestId: 'req_5', queueMs: 30 });
    traceRestAbort({ method: 'GET', path: '/tasks', requestId: 'req_5', durationMs: 5, queueMs: 30 });

    expect(traceHttpExchange('req_5')).toMatchObject({
      cancelled: true,
      durationMs: 5,
      queueMs: 30,
      responseBody: undefined,
      failure: undefined,
    });
  });

  it('reports the failure phase and body preview when the response cannot be parsed', () => {
    traceRestRequest({ method: 'GET', path: '/tasks', url: 'http://test/api/v1/tasks', requestId: 'req_2' });
    traceRestFailure({
      method: 'GET', path: '/tasks', requestId: 'req_2', phase: 'parse', durationMs: 8,
      status: 502, statusText: 'Bad Gateway', bodyPreview: '<html>bad gateway</html>',
      error: new Error('Unexpected token <'),
    });

    expect(traceHttpExchange('req_2')).toMatchObject({
      status: 502,
      statusText: 'Bad Gateway',
      responseBody: undefined,
      failure: { phase: 'parse', error: 'Error: Unexpected token <', bodyPreview: '<html>bad gateway</html>' },
    });
  });
});

describe('renderer error telemetry', () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    trackMock.mockClear();
    installClientErrorCapture()();
    vi.stubGlobal('window', new EventTarget());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dispose = installClientErrorCapture();
  });

  afterEach(() => {
    dispose();
    vi.unstubAllGlobals();
  });

  function windowError(message: string, error: Error | null = null): void {
    window.dispatchEvent(
      Object.assign(new Event('error'), { message, error, filename: 'app://renderer/assets/index-abc.js', lineno: 1, colno: 77 }),
    );
  }

  it('ignores the benign ResizeObserver loop notification entirely', () => {
    windowError('ResizeObserver loop completed with undelivered notifications.');
    windowError('ResizeObserver loop limit exceeded');
    expect(trackMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports source, fingerprint, top frame and boot phase, throttled per fingerprint', () => {
    windowError('Script failed to evaluate');
    windowError('Script failed to evaluate');
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('renderer_error', {
      error_class: 'Error',
      source: 'window',
      fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
      top_frame: 'index-abc.js:1:77',
      phase: 'boot',
    });
    expect(console.error).toHaveBeenCalledWith('[kimi-code] window error: Script failed to evaluate', undefined);

    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError('rejected boot task') }));
    expect(trackMock).toHaveBeenLastCalledWith('renderer_error', expect.objectContaining({
      error_class: 'TypeError',
      source: 'rejection',
      phase: 'boot',
    }));
  });

  it('marks errors after the UI is ready as running-phase errors', () => {
    markRendererRunning();
    reportRendererException(new RangeError('render loop after ready'), 'render function');
    expect(trackMock).toHaveBeenLastCalledWith('renderer_error', expect.objectContaining({
      error_class: 'RangeError',
      source: 'vue',
      phase: 'running',
    }));
  });
});
