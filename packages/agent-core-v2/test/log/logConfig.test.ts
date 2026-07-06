import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GLOBAL_FILES,
  DEFAULT_GLOBAL_MAX_BYTES,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SESSION_FILES,
  DEFAULT_SESSION_MAX_BYTES,
  ILogOptions,
  logSeed,
  resolveGlobalLogPath,
  resolveLoggingConfig,
  resolveSessionLogPath,
} from '#/_base/log/logConfig';
import { createScopedTestHost } from '#/_base/di/test';

describe('resolveLoggingConfig', () => {
  it('uses defaults when env is empty', () => {
    const cfg = resolveLoggingConfig({ homeDir: '/home/kimi', env: {} });
    expect(cfg.level).toBe(DEFAULT_LOG_LEVEL);
    expect(cfg.globalLogPath).toBe('/home/kimi/logs/kimi-code.log');
    expect(cfg.globalMaxBytes).toBe(DEFAULT_GLOBAL_MAX_BYTES);
    expect(cfg.globalFiles).toBe(DEFAULT_GLOBAL_FILES);
    expect(cfg.sessionMaxBytes).toBe(DEFAULT_SESSION_MAX_BYTES);
    expect(cfg.sessionFiles).toBe(DEFAULT_SESSION_FILES);
  });

  it('reads level and sizes from env', () => {
    const cfg = resolveLoggingConfig({
      homeDir: '/h',
      env: {
        KIMI_LOG_LEVEL: 'debug',
        KIMI_LOG_GLOBAL_MAX_BYTES: '1024',
        KIMI_LOG_GLOBAL_FILES: '7',
        KIMI_LOG_SESSION_MAX_BYTES: '2048',
        KIMI_LOG_SESSION_FILES: '4',
      },
    });
    expect(cfg.level).toBe('debug');
    expect(cfg.globalMaxBytes).toBe(1024);
    expect(cfg.globalFiles).toBe(7);
    expect(cfg.sessionMaxBytes).toBe(2048);
    expect(cfg.sessionFiles).toBe(4);
  });

  it('ignores invalid level and non-positive sizes', () => {
    const cfg = resolveLoggingConfig({
      homeDir: '/h',
      env: {
        KIMI_LOG_LEVEL: 'verbose',
        KIMI_LOG_GLOBAL_MAX_BYTES: '-5',
        KIMI_LOG_GLOBAL_FILES: 'abc',
      },
    });
    expect(cfg.level).toBe(DEFAULT_LOG_LEVEL);
    expect(cfg.globalMaxBytes).toBe(DEFAULT_GLOBAL_MAX_BYTES);
    expect(cfg.globalFiles).toBe(DEFAULT_GLOBAL_FILES);
  });

  it('resolves the log path regardless of env', () => {
    const cfg = resolveLoggingConfig({ homeDir: '/h', env: {} });
    expect(cfg.globalLogPath).toBe('/h/logs/kimi-code.log');
  });
});

describe('path resolution', () => {
  it('resolves the global log path under homeDir/logs', () => {
    expect(resolveGlobalLogPath('/home/kimi')).toBe('/home/kimi/logs/kimi-code.log');
  });

  it('resolves the session log path under sessionDir/logs', () => {
    expect(resolveSessionLogPath('/sessions/s1')).toBe('/sessions/s1/logs/kimi-code.log');
  });
});

describe('logSeed', () => {
  it('seeds ILogOptions into a App scope', () => {
    const cfg = resolveLoggingConfig({ homeDir: '/h', env: { KIMI_LOG_LEVEL: 'warn' } });
    const host = createScopedTestHost(logSeed(cfg));
    const opts = host.app.accessor.get(ILogOptions);
    expect(opts.level).toBe('warn');
    expect(opts.globalLogPath).toBe('/h/logs/kimi-code.log');
    host.dispose();
  });
});
