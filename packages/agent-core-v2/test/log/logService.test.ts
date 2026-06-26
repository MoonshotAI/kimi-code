import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  ConsoleLogSink,
  ILogService,
  ILogSink,
  LogService,
  MemoryLogSink,
  levelEnabled,
} from '#/log/index';
import { registerScopedService } from '#/_base/di/scope';

describe('LogService (unit)', () => {
  it('emits entries to the sink at/above the configured level', () => {
    const sink = new MemoryLogSink();
    const log = new LogService(sink, {}, 'info');
    log.debug('hidden');
    log.info('hello');
    log.warn('careful');
    expect(sink.entries.map((e) => e.msg)).toEqual(['hello', 'careful']);
    expect(sink.entries.every((e) => typeof e.t === 'number')).toBe(true);
  });

  it('extracts Error payload onto entry.error', () => {
    const sink = new MemoryLogSink();
    const log = new LogService(sink, {}, 'info');
    const err = new Error('boom');
    log.error('failed', err);
    expect(sink.entries[0]?.error?.message).toBe('boom');
    expect(sink.entries[0]?.error?.stack).toContain('boom');
  });

  it('merges object payload into ctx', () => {
    const sink = new MemoryLogSink();
    const log = new LogService(sink, {}, 'debug');
    log.info('with ctx', { requestId: 'r1', count: 2 });
    expect(sink.entries[0]?.ctx).toEqual({ requestId: 'r1', count: 2 });
  });

  it('child merges bound context and bound wins over payload', () => {
    const sink = new MemoryLogSink();
    const parent = new LogService(sink, {}, 'debug');
    const child = parent.child({ sessionId: 's1', agentId: 'main' });
    child.info('evt', { sessionId: 'override', extra: 'x' });
    expect(sink.entries[0]?.ctx).toEqual({
      sessionId: 's1',
      agentId: 'main',
      extra: 'x',
    });
  });

  it('child chains accumulate context', () => {
    const sink = new MemoryLogSink();
    const root = new LogService(sink, {}, 'debug');
    const leaf = root.child({ a: 1 }).child({ b: 2 });
    leaf.info('evt');
    expect(sink.entries[0]?.ctx).toEqual({ a: 1, b: 2 });
  });

  it('setLevel changes filtering at runtime', () => {
    const sink = new MemoryLogSink();
    const log = new LogService(sink, {}, 'error');
    log.info('hidden');
    log.setLevel('info');
    log.info('shown');
    expect(sink.entries.map((e) => e.msg)).toEqual(['shown']);
  });
});

describe('levelEnabled', () => {
  it('respects ordering and off', () => {
    expect(levelEnabled('error', 'info')).toBe(true);
    expect(levelEnabled('debug', 'info')).toBe(false);
    expect(levelEnabled('info', 'off')).toBe(false);
    expect(levelEnabled('info', 'debug')).toBe(true);
  });
});

describe('ILogService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      ILogSink,
      ConsoleLogSink,
      InstantiationType.Eager,
      'log',
    );
    registerScopedService(
      LifecycleScope.Core,
      ILogService,
      LogService,
      InstantiationType.Eager,
      'log',
    );
  });

  it('resolves ILogService from the Core scope with its sink injected', () => {
    const sink = new MemoryLogSink();
    const host = createScopedTestHost([stubPair(ILogSink, sink)]);
    const log = host.core.accessor.get(ILogService);
    log.info('scoped-hello');
    expect(sink.entries.map((e) => e.msg)).toEqual(['scoped-hello']);
    host.dispose();
  });

  it('a scoped child logger bound to sessionId is resolvable downstream', () => {
    const sink = new MemoryLogSink();
    const host = createScopedTestHost([stubPair(ILogSink, sink)]);
    const root = host.core.accessor.get(ILogService);
    const sessionLog = root.child({ sessionId: 's1' });
    sessionLog.warn('bound');
    expect(sink.entries[0]?.ctx).toEqual({ sessionId: 's1' });
    host.dispose();
  });
});
