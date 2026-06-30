import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  ILogWriterService,
  ISessionLogService,
  resolveLoggingConfig,
  resolveSessionLogPath,
} from '#/log/index';
import { logSeed } from '#/log/logConfig';
import { SessionFileLogWriterService } from '#/log/logWriter';
import { SessionLogService } from '#/log/sessionLogService';
import { sessionContextSeed } from '#/session-context';

let homeDir: string;
let sessionDir: string;

beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(
    LifecycleScope.Session,
    ILogWriterService,
    SessionFileLogWriterService,
    InstantiationType.Delayed,
    'log',
  );
  registerScopedService(
    LifecycleScope.Session,
    ISessionLogService,
    SessionLogService,
    InstantiationType.Delayed,
    'log',
  );
  homeDir = await mkdtemp(join(tmpdir(), 'session-log-'));
  sessionDir = join(homeDir, 'sessions', 's1');
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function buildHost() {
  const cfg = resolveLoggingConfig({
    homeDir,
    env: { KIMI_LOG_LEVEL: 'debug', KIMI_LOG_SESSION_MAX_BYTES: '1024', KIMI_LOG_SESSION_FILES: '2' },
  });
  return createScopedTestHost(logSeed(cfg));
}

function testSessionSeed() {
  return sessionContextSeed({
    _serviceBrand: undefined,
    sessionId: 's1',
    workspaceId: 'test-workspace',
    sessionDir,
    metaScope: 'sessions/test-workspace/s1/session-meta',
  });
}

async function readSessionLog(): Promise<string> {
  try {
    return await readFile(resolveSessionLogPath(sessionDir), 'utf-8');
  } catch {
    return '';
  }
}

describe('SessionLogService', () => {
  it('writes entries to the per-session log file', async () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ISessionLogService);
    log.info('session event', { requestId: 'r1' });
    await log.flush();
    const text = await readSessionLog();
    expect(text).toContain('session event');
    expect(text).toContain('requestId=r1');
    host.dispose();
  });

  it('omits sessionId from per-session lines', async () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ISessionLogService);
    log.info('evt');
    await log.flush();
    const text = await readSessionLog();
    expect(text).not.toContain('sessionId');
    host.dispose();
  });

  it('child logger accumulates context and writes to the same file', async () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ISessionLogService);
    log.child({ agentId: 'main' }).warn('child event');
    await log.flush();
    const text = await readSessionLog();
    expect(text).toContain('child event');
    expect(text).toContain('agentId=main');
    host.dispose();
  });

  it('close flushes and a subsequent write is dropped', async () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ISessionLogService);
    log.info('before-close');
    await log.close();
    log.info('after-close');
    const text = await readSessionLog();
    expect(text).toContain('before-close');
    expect(text).not.toContain('after-close');
    host.dispose();
  });

  it('dispose flushes pending entries synchronously', () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ISessionLogService);
    log.info('on-dispose');
    host.dispose();
    // dispose() is synchronous and uses flushSync; read after the call returns.
    return readSessionLog().then((text) => {
      expect(text).toContain('on-dispose');
    });
  });
});
