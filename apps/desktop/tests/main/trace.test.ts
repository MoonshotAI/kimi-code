import { describe, it, expect, vi } from 'vitest';

import { createTraceRecorder, traceFileName } from '../../src/main/trace';
import type { TraceRecorderDeps } from '../../src/main/trace';

function makeDeps(overrides: Partial<TraceRecorderDeps> = {}) {
  const deps: TraceRecorderDeps = {
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => '/tmp/trace-abc.json'),
    showSaveDialog: vi.fn(async () => '/chosen/kimi-code-trace.json'),
    moveFile: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    downloadsDir: () => '/downloads',
    ...overrides,
  };
  return deps;
}

describe('traceFileName', () => {
  it('formats the timestamp into a trace filename', () => {
    expect(traceFileName(new Date(2026, 6, 27, 9, 5, 3))).toBe('kimi-code-trace-20260727-090503.json');
  });
});

describe('createTraceRecorder', () => {
  it('starts recording with the jank-diagnosis category set', async () => {
    const deps = makeDeps();
    const recorder = createTraceRecorder(deps);
    expect(recorder.isRecording()).toBe(false);
    const result = await recorder.toggle();
    expect(result).toEqual({ status: 'started' });
    expect(recorder.isRecording()).toBe(true);
    expect(vi.mocked(deps.startRecording).mock.calls[0]?.[0]).toContain('disabled-by-default-v8.cpu_profiler');
  });

  it('stops, then moves the temp trace to the dialog-chosen path', async () => {
    const deps = makeDeps();
    const recorder = createTraceRecorder(deps);
    await recorder.toggle();
    const result = await recorder.toggle();
    expect(result).toEqual({ status: 'saved', path: '/chosen/kimi-code-trace.json' });
    expect(recorder.isRecording()).toBe(false);
    // Save dialog pre-fills the downloads dir + suggested filename.
    const defaultPath = vi.mocked(deps.showSaveDialog).mock.calls[0]?.[0] as string;
    expect(defaultPath.startsWith('/downloads/kimi-code-trace-')).toBe(true);
    expect(defaultPath.endsWith('.json')).toBe(true);
    expect(deps.moveFile).toHaveBeenCalledWith('/tmp/trace-abc.json', '/chosen/kimi-code-trace.json');
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it('deletes the temp trace when the save dialog is cancelled', async () => {
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => undefined) });
    const recorder = createTraceRecorder(deps);
    await recorder.toggle();
    const result = await recorder.toggle();
    expect(result).toEqual({ status: 'discarded' });
    expect(deps.removeFile).toHaveBeenCalledWith('/tmp/trace-abc.json');
    expect(deps.moveFile).not.toHaveBeenCalled();
  });

  it('a start failure reports an error and stays stopped', async () => {
    const deps = makeDeps({ startRecording: vi.fn(async () => Promise.reject(new Error('no categories'))) });
    const recorder = createTraceRecorder(deps);
    const result = await recorder.toggle();
    expect(result.status).toBe('error');
    expect(recorder.isRecording()).toBe(false);
  });

  it('a stop failure reports an error and clears the recording state', async () => {
    const deps = makeDeps({ stopRecording: vi.fn(async () => Promise.reject(new Error('not recording'))) });
    const recorder = createTraceRecorder(deps);
    await recorder.toggle();
    const result = await recorder.toggle();
    expect(result.status).toBe('error');
    expect(recorder.isRecording()).toBe(false);
    // Recovers: a fresh start works afterwards.
    expect(await recorder.toggle()).toEqual({ status: 'started' });
  });

  it('a save failure keeps the temp trace and reports its path as keptAt', async () => {
    const deps = makeDeps({ moveFile: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    const recorder = createTraceRecorder(deps);
    await recorder.toggle();
    const result = await recorder.toggle();
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('disk full');
      expect(result.keptAt).toBe('/tmp/trace-abc.json');
    }
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it('rejects a re-entrant toggle while a start is still in flight', async () => {
    let resolveStart: (() => void) | undefined;
    const deps = makeDeps({
      startRecording: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    });
    const recorder = createTraceRecorder(deps);
    const starting = recorder.toggle();
    expect(await recorder.toggle()).toEqual({ status: 'busy' });
    resolveStart?.();
    expect(await starting).toEqual({ status: 'started' });
    expect(deps.startRecording).toHaveBeenCalledOnce();
  });

  it('rejects a re-entrant toggle while the stop/save flow is in flight', async () => {
    let resolveDialog: ((path: string | undefined) => void) | undefined;
    const deps = makeDeps({
      showSaveDialog: vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolveDialog = resolve;
          }),
      ),
    });
    const recorder = createTraceRecorder(deps);
    await recorder.toggle();
    const stopping = recorder.toggle();
    expect(await recorder.toggle()).toEqual({ status: 'busy' });
    resolveDialog?.('/chosen/trace.json');
    expect(await stopping).toEqual({ status: 'saved', path: '/chosen/trace.json' });
  });
});
