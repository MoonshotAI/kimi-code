import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { ConsoleLogWriter, MemoryLogWriter } from '#/_base/log/fileLog';
import {
  ILogService,
  type LogEntry,
  levelEnabled,
} from '#/_base/log/log';
import {
  logSeed,
  resolveGlobalLogPath,
  resolveLoggingConfig,
} from '#/_base/log/logConfig';
import { AppLogService, BoundLogger } from '#/_base/log/logService';

describe('BoundLogger', () => {
  let sink: MemoryLogWriter;
  let logger: BoundLogger;

  beforeEach(() => {
    sink = new MemoryLogWriter();
    logger = new BoundLogger(sink, { level: 'info' });
  });

  it('emits entries to the sink at/above the configured level', () => {
    logger.debug('hidden');
    logger.info('hello');
    logger.warn('careful');
    expect(sink.entries.map((e) => e.msg)).toEqual(['hello', 'careful']);
    expect(sink.entries.every((e) => typeof e.t === 'number')).toBe(true);
  });

  it('extracts Error payload onto entry.error', () => {
    const err = new Error('boom');
    logger.error('failed', err);
    expect(sink.entries[0]?.error?.message).toBe('boom');
    expect(sink.entries[0]?.error?.stack).toContain('boom');
  });

  it('hoists a bunyan-style ctx.error payload onto entry.error', () => {
    const err = new Error('persist failed');
    logger.error('wire persist failed', { agentHomedir: '/tmp/a', error: err });
    expect(sink.entries[0]?.ctx).toEqual({ agentHomedir: '/tmp/a' });
    expect(sink.entries[0]?.error?.message).toBe('persist failed');
    expect(sink.entries[0]?.error?.stack).toContain('persist failed');
  });

  it('coerces primitive payloads into a reason field', () => {
    logger.warn('weird path', 'oh no');
    logger.warn('numeric path', 42);
    expect(sink.entries[0]?.ctx).toEqual({ reason: 'oh no' });
    expect(sink.entries[1]?.ctx).toEqual({ reason: '42' });
  });

  it('accepts a catch binding without manual wrapping', () => {
    try {
      throw new Error('caught');
    } catch (error) {
      logger.error('caught it', error);
    }
    expect(sink.entries[0]?.error?.message).toBe('caught');
  });

  it('does not let throwing payload accessors escape into caller flow', () => {
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
    expect(() => logger.warn('proxy payload', payload)).not.toThrow();
    expect(sink.entries.map((e) => e.msg)).not.toContain('proxy payload');
  });

  it('merges object payload into ctx', () => {
    const debugLogger = new BoundLogger(sink, { level: 'debug' });
    debugLogger.info('with ctx', { requestId: 'r1', count: 2 });
    expect(sink.entries[0]?.ctx).toEqual({ requestId: 'r1', count: 2 });
  });

  it('child merges bound context and bound wins over payload', () => {
    const child = logger.child({ sessionId: 's1', agentId: 'main' });
    child.info('evt', { sessionId: 'override', extra: 'x' });
    expect(sink.entries[0]?.ctx).toEqual({
      sessionId: 's1',
      agentId: 'main',
      extra: 'x',
    });
  });

  it('child chains accumulate context', () => {
    const leaf = logger.child({ a: 1 }).child({ b: 2 });
    leaf.info('evt');
    expect(sink.entries[0]?.ctx).toEqual({ a: 1, b: 2 });
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

describe('ConsoleLogWriter', () => {
  it('redacts secret-shaped ctx through the formatter', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const writer = new ConsoleLogWriter();
      const entry: LogEntry = {
        t: 0,
        level: 'info',
        msg: 'auth',
        ctx: { token: 'super-secret', path: '/x' },
      };
      writer.write(entry);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]?.[0] as string;
      expect(line).toContain('token=[REDACTED]');
      expect(line).toContain('path=/x');
      expect(line).not.toContain('super-secret');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AppLogService (scoped)', () => {
  let homeDir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ILogService,
      AppLogService,
      InstantiationType.Delayed,
      'log',
    );
    homeDir = await mkdtemp(join(tmpdir(), 'global-log-'));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildHost(cfg = resolveLoggingConfig({ homeDir, env: { KIMI_LOG_LEVEL: 'info' } })) {
    return createScopedTestHost(logSeed(cfg));
  }

  it('writes to the global log file and flush drains it', async () => {
    const host = buildHost();
    const log = host.app.accessor.get(ILogService);
    log.info('global event', { requestId: 'g1' });
    await log.flush();
    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('global event');
    expect(text).toContain('requestId=g1');
    host.dispose();
  });

  it('reads its level from ILogOptions', async () => {
    const host = buildHost(resolveLoggingConfig({ homeDir, env: { KIMI_LOG_LEVEL: 'debug' } }));
    const log = host.app.accessor.get(ILogService);
    log.debug('debug-shown');
    await log.flush();
    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('debug-shown');
    host.dispose();
  });

  it('setLevel changes filtering at runtime', async () => {
    const host = buildHost();
    const log = host.app.accessor.get(ILogService);
    log.setLevel('error');
    log.info('hidden');
    log.setLevel('info');
    log.info('shown');
    await log.flush();
    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('shown');
    expect(text).not.toContain('hidden');
    host.dispose();
  });
});
