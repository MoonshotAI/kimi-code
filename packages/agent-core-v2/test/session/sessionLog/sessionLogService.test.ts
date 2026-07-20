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
import { ILogService } from '#/_base/log/log';
import {
  logSeed,
  resolveLoggingConfig,
  resolveSessionLogPath,
} from '#/_base/log/logConfig';
import { AppLogService } from '#/_base/log/logService';
import { SessionLogService } from '#/session/sessionLog/sessionLogService';
import { makeSessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';

let homeDir: string;
let sessionDir: string;

beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(
    LifecycleScope.Session,
    ILogService,
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
  return sessionContextSeed(makeSessionContext({
    sessionId: 's1',
    workspaceId: 'test-workspace',
    sessionDir,
    sessionScope: 'sessions/test-workspace/s1',
    metaScope: 'sessions/test-workspace/s1/session-meta',
    cwd: sessionDir,
  }));
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
    const log = session.accessor.get(ILogService);
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
    const log = session.accessor.get(ILogService);
    log.info('evt');
    await log.flush();
    const text = await readSessionLog();
    expect(text).not.toContain('sessionId');
    host.dispose();
  });

  it('child logger accumulates context and writes to the same file', async () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const log = session.accessor.get(ILogService);
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
    const log = session.accessor.get(ILogService) as SessionLogService;
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
    const log = session.accessor.get(ILogService);
    log.info('on-dispose');
    host.dispose();
    return readSessionLog().then((text) => {
      expect(text).toContain('on-dispose');
    });
  });
});

describe('ILogService cross-scope resolution', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, ILogService, AppLogService, InstantiationType.Delayed, 'log');
    registerScopedService(LifecycleScope.Session, ILogService, SessionLogService, InstantiationType.Delayed, 'log');
  });

  it('resolves the single token to the nearest scope binding', () => {
    const host = buildHost();
    const session = host.child(LifecycleScope.Session, 's1', testSessionSeed());
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const appLog = host.app.accessor.get(ILogService);
    const sessionLog = session.accessor.get(ILogService);
    const agentLog = agent.accessor.get(ILogService);

    expect(appLog).toBeInstanceOf(AppLogService);
    expect(sessionLog).toBeInstanceOf(SessionLogService);
    expect(agentLog).toBeInstanceOf(SessionLogService);

    expect(appLog).not.toBe(sessionLog);
    expect(agentLog).toBe(sessionLog);

    host.dispose();
  });
});
