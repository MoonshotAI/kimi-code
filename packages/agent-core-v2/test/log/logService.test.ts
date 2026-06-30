import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import type { TestInstantiationService } from '#/_base/di/test';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import {
  ILogService,
  ILogWriterService,
  levelEnabled,
} from '#/log/log';
import {
  ConsoleLogWriterService,
  LogService,
  MemoryLogWriterService,
} from '#/log/logService';

describe('LogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let sink: MemoryLogWriterService;

  beforeEach(() => {
    disposables = new DisposableStore();
    sink = new MemoryLogWriterService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ILogWriterService, sink);
        reg.define(ILogService, LogService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('emits entries to the sink at/above the configured level', () => {
    const log = ix.get(ILogService);
    log.debug('hidden');
    log.info('hello');
    log.warn('careful');
    expect(sink.entries.map((e) => e.msg)).toEqual(['hello', 'careful']);
    expect(sink.entries.every((e) => typeof e.t === 'number')).toBe(true);
  });

  it('extracts Error payload onto entry.error', () => {
    const log = ix.get(ILogService);
    const err = new Error('boom');
    log.error('failed', err);
    expect(sink.entries[0]?.error?.message).toBe('boom');
    expect(sink.entries[0]?.error?.stack).toContain('boom');
  });

  it('hoists a bunyan-style ctx.error payload onto entry.error', () => {
    const log = ix.get(ILogService);
    const err = new Error('persist failed');
    log.error('wire persist failed', { agentHomedir: '/tmp/a', error: err });

    expect(sink.entries[0]?.ctx).toEqual({ agentHomedir: '/tmp/a' });
    expect(sink.entries[0]?.error?.message).toBe('persist failed');
    expect(sink.entries[0]?.error?.stack).toContain('persist failed');
  });

  it('coerces primitive payloads into a reason field', () => {
    const log = ix.get(ILogService);
    log.warn('weird path', 'oh no');
    log.warn('numeric path', 42);

    expect(sink.entries[0]?.ctx).toEqual({ reason: 'oh no' });
    expect(sink.entries[1]?.ctx).toEqual({ reason: '42' });
  });

  it('accepts a catch binding without manual wrapping', () => {
    const log = ix.get(ILogService);
    try {
      throw new Error('caught');
    } catch (error) {
      log.error('caught it', error);
    }

    expect(sink.entries[0]?.error?.message).toBe('caught');
  });

  it('does not let throwing payload accessors escape into caller flow', () => {
    const log = ix.get(ILogService);
    const payload = new Proxy(
      {},
      {
        get() {
          throw new Error('getter boom');
        },
        ownKeys() {
          return ['error'];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true };
        },
      },
    );

    expect(() => log.warn('proxy payload', payload)).not.toThrow();
    expect(sink.entries.map((e) => e.msg)).not.toContain('proxy payload');
  });

  it('merges object payload into ctx', () => {
    const log = ix.get(ILogService);
    log.setLevel('debug');
    log.info('with ctx', { requestId: 'r1', count: 2 });
    expect(sink.entries[0]?.ctx).toEqual({ requestId: 'r1', count: 2 });
  });

  it('child merges bound context and bound wins over payload', () => {
    const parent = ix.get(ILogService);
    parent.setLevel('debug');
    const child = parent.child({ sessionId: 's1', agentId: 'main' });
    child.info('evt', { sessionId: 'override', extra: 'x' });
    expect(sink.entries[0]?.ctx).toEqual({
      sessionId: 's1',
      agentId: 'main',
      extra: 'x',
    });
  });

  it('child chains accumulate context', () => {
    const root = ix.get(ILogService);
    root.setLevel('debug');
    const leaf = root.child({ a: 1 }).child({ b: 2 });
    leaf.info('evt');
    expect(sink.entries[0]?.ctx).toEqual({ a: 1, b: 2 });
  });

  it('setLevel changes filtering at runtime', () => {
    const log = ix.get(ILogService);
    log.setLevel('error');
    log.info('hidden');
    log.setLevel('info');
    log.info('shown');
    expect(sink.entries.map((e) => e.msg)).toEqual(['shown']);
  });

  it('flush delegates to the sink when present', async () => {
    let flushed = false;
    (sink as MemoryLogWriterService & { flush?: () => Promise<void> }).flush = () => {
      flushed = true;
      return Promise.resolve();
    };
    const log = ix.get(ILogService);
    await log.flush();
    expect(flushed).toBe(true);
  });

  it('flush resolves when the sink has no flush', async () => {
    const log = ix.get(ILogService);
    await expect(log.flush()).resolves.toBeUndefined();
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
      ILogWriterService,
      ConsoleLogWriterService,
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
    const sink = new MemoryLogWriterService();
    const host = createScopedTestHost([stubPair(ILogWriterService, sink)]);
    const log = host.core.accessor.get(ILogService);
    log.info('scoped-hello');
    expect(sink.entries.map((e) => e.msg)).toEqual(['scoped-hello']);
    host.dispose();
  });

  it('a scoped child logger bound to sessionId is resolvable downstream', () => {
    const sink = new MemoryLogWriterService();
    const host = createScopedTestHost([stubPair(ILogWriterService, sink)]);
    const root = host.core.accessor.get(ILogService);
    const sessionLog = root.child({ sessionId: 's1' });
    sessionLog.warn('bound');
    expect(sink.entries[0]?.ctx).toEqual({ sessionId: 's1' });
    host.dispose();
  });
});
