import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetRootLoggerForTest,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
} from '#/logging/logger';

let homeDir: string;

beforeEach(async () => {
  await __resetRootLoggerForTest();
  homeDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
});

afterEach(async () => {
  await __resetRootLoggerForTest();
  await rm(homeDir, { recursive: true, force: true });
});

function defaultConfig(level: 'info' | 'debug' | 'warn' | 'error' | 'off' = 'info') {
  return {
    level,
    globalLogPath: resolveGlobalLogPath(homeDir),
    globalMaxBytes: 1_000_000,
    globalFiles: 3,
    sessionMaxBytes: 500_000,
    sessionFiles: 2,
  } as const;
}

async function readGlobal(): Promise<string> {
  return readGlobalAt(homeDir);
}

async function readGlobalAt(dir: string): Promise<string> {
  try {
    return await readFile(resolveGlobalLogPath(dir), 'utf-8');
  } catch {
    return '';
  }
}

describe('log — pre-configure noop', () => {
  it('silently swallows calls before configure', async () => {
    expect(() => {
      log.info('before configure');
    }).not.toThrow();
    expect(await readGlobal()).toBe('');
  });

  it('the same `log` import routes to sink after configure (late-binding)', async () => {
    log.info('pre-config'); // dropped
    await getRootLogger().configure(defaultConfig());
    log.info('post-config');
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).not.toContain('pre-config');
    expect(text).toContain('post-config');
  });
});

describe('configure idempotency', () => {
  it('second configure with deep-equal config is a no-op', async () => {
    await getRootLogger().configure(defaultConfig());
    log.info('one');
    await getRootLogger().flush();
    await getRootLogger().configure(defaultConfig());
    log.info('two');
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('one');
    expect(text).toContain('two');
  });

  it('does not throw on multiple harness-like configure cycles', async () => {
    for (let i = 0; i < 3; i++) {
      await getRootLogger().configure(defaultConfig());
    }
    expect(getRootLogger().isConfigured()).toBe(true);
  });

  it('reconfigures the global sink when config changes', async () => {
    await getRootLogger().configure(defaultConfig('info'));
    const nextHomeDir = await mkdtemp(join(tmpdir(), 'logger-next-home-'));
    try {
      await getRootLogger().configure({
        ...defaultConfig('debug'),
        globalLogPath: resolveGlobalLogPath(nextHomeDir),
      });
      log.debug('after-reconfigure');
      await getRootLogger().flushGlobal();
      expect(await readGlobal()).not.toContain('after-reconfigure');
      expect(await readGlobalAt(nextHomeDir)).toContain('after-reconfigure');
    } finally {
      await rm(nextHomeDir, { recursive: true, force: true });
    }
  });
});

describe('level filtering', () => {
  it('drops entries below configured level', async () => {
    await getRootLogger().configure(defaultConfig('warn'));
    log.info('info-line');
    log.warn('warn-line');
    log.error('error-line');
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).not.toContain('info-line');
    expect(text).toContain('warn-line');
    expect(text).toContain('error-line');
  });

  it('off level disables all output', async () => {
    await getRootLogger().configure(defaultConfig('off'));
    log.error('should-not-write');
    await getRootLogger().flush();
    expect(await readGlobal()).toBe('');
  });
});

describe('payload shapes', () => {
  it('accepts Error directly (no manual wrap needed)', async () => {
    await getRootLogger().configure(defaultConfig());
    const err = new Error('boom');
    log.error('provider failed', err);
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('provider failed');
    expect(text).toMatch(/Error: boom/);
  });

  it('accepts plain object as ctx', async () => {
    await getRootLogger().configure(defaultConfig());
    log.info('hello', { sessionId: 'ses_x', model: 'kimi-k2' });
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('sessionId=ses_x');
    expect(text).toContain('model=kimi-k2');
  });

  it('bunyan-style: ctx with `error: Error` field hoists stack out', async () => {
    await getRootLogger().configure(defaultConfig());
    const err = new Error('persist failed');
    log.error('wire persist failed', { agentHomedir: '/tmp/a', error: err });
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('agentHomedir=/tmp/a');
    expect(text).toMatch(/Error: persist failed/);
  });

  it('coerces primitive payload into a reason field', async () => {
    await getRootLogger().configure(defaultConfig());
    log.warn('weird path', 'oh no');
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('reason="oh no"');
  });

  it('accepts a `catch (e: unknown)` binding without wrapping', async () => {
    await getRootLogger().configure(defaultConfig());
    try {
      throw new Error('caught');
    } catch (error) {
      log.error('caught it', error);
    }
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toMatch(/Error: caught/);
  });

  it('does not let throwing payload accessors escape into caller flow', async () => {
    await getRootLogger().configure(defaultConfig());
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

    expect(() => {
      log.warn('proxy payload', payload);
    }).not.toThrow();
    await getRootLogger().flush();
    expect(await readGlobal()).not.toContain('proxy payload');
  });
});

describe('createChild', () => {
  it('binds ctx that travels with every entry', async () => {
    await getRootLogger().configure(defaultConfig());
    const sessionLog = log.createChild({ sessionId: 'ses_a', model: 'kimi-k2' });
    sessionLog.info('first');
    sessionLog.warn('second', { extra: 'x' });
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toMatch(/first.*sessionId=ses_a.*model=kimi-k2/);
    expect(text).toMatch(/second.*extra=x.*sessionId=ses_a/);
  });

  it('chains: parent ctx + child ctx + call ctx all merged', async () => {
    await getRootLogger().configure(defaultConfig());
    const sessionLog = log.createChild({ sessionId: 'ses_a' });
    const agentLog = sessionLog.createChild({ agentId: 'main' });
    agentLog.info('turn started', { turnId: 7 });
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('sessionId=ses_a');
    expect(text).toContain('agentId=main');
    expect(text).toContain('turnId=7');
  });

  it('bound ctx overrides call-site ctx (cannot accidentally overwrite ownership)', async () => {
    await getRootLogger().configure(defaultConfig());
    const sessionLog = log.createChild({ sessionId: 'ses_a' });
    sessionLog.info('msg', { sessionId: 'ses_FAKE', extra: 'k' });
    await getRootLogger().flush();
    const text = await readGlobal();
    expect(text).toContain('sessionId=ses_a');
    expect(text).not.toContain('ses_FAKE');
    expect(text).toContain('extra=k');
  });
});

describe('session routing', () => {
  it('writes sessionId-tagged entries to session sink only', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const handle = getRootLogger().attachSession({ sessionId: 'ses_abc', sessionDir });
      const sessionLog = log.createChild({ sessionId: 'ses_abc' });
      sessionLog.info('hello');
      await handle.flush();
      await getRootLogger().flush();
      const global = await readGlobal();
      const session = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(global).not.toContain('hello');
      expect(session).toContain('hello');
      await handle.close();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('omits stable main-agent fields from all session lines with agentId=main', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const handle = getRootLogger().attachSession({ sessionId: 'ses_abc', sessionDir });
      const sessionLog = handle.logger.createChild({ agentId: 'main' });
      sessionLog.info('llm config', { model: 'kimi-k2' });
      sessionLog.info('llm request', { turn: 0, step: 1 });
      await handle.flush();
      await getRootLogger().flush();

      const global = await readGlobal();
      expect(global).not.toMatch(/llm config/);
      expect(global).not.toMatch(/llm request/);

      const session = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(session).toMatch(/llm config(?!.*sessionId=ses_abc)/);
      expect(session).toMatch(/llm config(?!.*agentId=main)/);
      expect(session).toMatch(/llm request(?!.*sessionId=ses_abc)/);
      expect(session).toMatch(/llm request(?!.*agentId=main)/);
      await handle.close();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps subagent ids on session llm request lines', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const handle = getRootLogger().attachSession({ sessionId: 'ses_abc', sessionDir });
      const sessionLog = handle.logger.createChild({ agentId: 'agent-0' });
      sessionLog.info('llm request', { turn: 0, step: 1 });
      await handle.flush();
      await getRootLogger().flush();

      const session = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(session).toMatch(/llm request.*agentId=agent-0/);
      expect(session).toMatch(/llm request(?!.*sessionId=ses_abc)/);
      await handle.close();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('writes entries without sessionId only to global (not broadcast)', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const handle = getRootLogger().attachSession({ sessionId: 'ses_abc', sessionDir });
      log.info('bootstrap event');
      await getRootLogger().flush();
      await handle.flush();
      const global = await readGlobal();
      expect(global).toContain('bootstrap event');
      let sessionText = '';
      try {
        sessionText = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      } catch {}
      expect(sessionText).not.toContain('bootstrap event');
      await handle.close();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps same-id sessions in different directories isolated', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'logger-session-a-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'logger-session-b-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const first = getRootLogger().attachSession({ sessionId: 'ses_same', sessionDir: firstDir });
      const second = getRootLogger().attachSession({
        sessionId: 'ses_same',
        sessionDir: secondDir,
      });

      first.logger.info('first only');
      second.logger.info('second only');
      log.info('ambiguous session id', { sessionId: 'ses_same' });
      await getRootLogger().flush();

      const firstText = await readFile(join(firstDir, 'logs', 'kimi-code.log'), 'utf-8');
      const secondText = await readFile(join(secondDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(firstText).toContain('first only');
      expect(firstText).not.toContain('second only');
      expect(firstText).not.toContain('ambiguous session id');
      expect(secondText).toContain('second only');
      expect(secondText).not.toContain('first only');
      expect(secondText).not.toContain('ambiguous session id');

      const global = await readGlobal();
      expect(global).not.toContain('first only');
      expect(global).not.toContain('second only');
      expect(global).toContain('ambiguous session id');

      await first.close();
      await second.close();
    } finally {
      await rm(firstDir, { recursive: true, force: true });
      await rm(secondDir, { recursive: true, force: true });
    }
  });

  it('keeps a reused same-directory session sink open until every handle closes', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-shared-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const first = getRootLogger().attachSession({ sessionId: 'ses_shared', sessionDir });
      const second = getRootLogger().attachSession({ sessionId: 'ses_shared', sessionDir });

      await first.close();
      await first.close();

      second.logger.info('still routes after first close');
      await second.flush();

      const text = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(text).toContain('still routes after first close');
      await second.close();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not let a closing handle remove a replacement session sink', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'logger-session-old-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'logger-session-new-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const first = getRootLogger().attachSession({
        sessionId: 'ses_replace',
        sessionDir: firstDir,
      });

      const closing = first.close();
      const second = getRootLogger().attachSession({
        sessionId: 'ses_replace',
        sessionDir: secondDir,
      });
      await closing;

      second.logger.info('replacement still routes');
      await second.flush();

      const secondText = await readFile(join(secondDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(secondText).toContain('replacement still routes');
      await second.close();
    } finally {
      await rm(firstDir, { recursive: true, force: true });
      await rm(secondDir, { recursive: true, force: true });
    }
  });

  it('waits for a closing session sink when flushing by session id', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'logger-session-closing-'));
    try {
      await getRootLogger().configure(defaultConfig());
      const handle = getRootLogger().attachSession({ sessionId: 'ses_closing', sessionDir });
      handle.logger.info('close flush marker');

      const closing = handle.close();
      await expect(getRootLogger().flushSession('ses_closing')).resolves.toBe(true);
      await closing;

      const text = await readFile(join(sessionDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(text).toContain('close flush marker');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('redact helper', () => {
  it('returns same shape with sensitive fields replaced', () => {
    const out = redact({ user: 'x', token: 'abc', nested: { apiKey: '1' } });
    expect(out.user).toBe('x');
    expect(out.token).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
  });

  it('passes primitives through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact('hi')).toBe('hi');
    expect(redact(null)).toBe(null);
  });

  it('processes arrays', () => {
    const out = redact([{ token: '1' }, { apiKey: '2' }]);
    expect(out[0]?.token).toBe('[REDACTED]');
    expect(out[1]?.apiKey).toBe('[REDACTED]');
  });

  it('handles cyclic arrays without recursing forever', () => {
    const input: unknown[] = [];
    input.push(input);

    const out = redact(input);

    expect(out[0]).toBe('[REDACTED:cycle]');
  });
});
