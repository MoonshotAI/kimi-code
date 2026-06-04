import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, log } from '#/index';
import { __resetRootLoggerForTest, getRootLogger } from '../../agent-core/src/logging/logger';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

const LOG_ENV_KEYS = [
  'KIMI_LOG_LEVEL',
  'KIMI_LOG_GLOBAL_MAX_BYTES',
  'KIMI_LOG_GLOBAL_FILES',
  'KIMI_LOG_SESSION_MAX_BYTES',
  'KIMI_LOG_SESSION_FILES',
] as const;

beforeEach(async () => {
  process.env['KIMI_LOG_LEVEL'] = 'info';
  await __resetRootLoggerForTest();
});

afterEach(async () => {
  await __resetRootLoggerForTest();
  process.env['KIMI_LOG_LEVEL'] = 'off';
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

function snapshotLogEnv(): Record<(typeof LOG_ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(LOG_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof LOG_ENV_KEYS)[number],
    string | undefined
  >;
}

function restoreLogEnv(snapshot: Record<(typeof LOG_ENV_KEYS)[number], string | undefined>): void {
  for (const key of LOG_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip eocd not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad cd entry');
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnameLen);
    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) throw new Error('bad lfh');
    const lfhFnameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data === null) throw new Error('unsupported compression');
    entries.set(filename, data);
    pos += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}

describe('Local logging — harness integration', () => {
  it('writes session-tagged entries to session log only and untagged entries to global', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({
      id: 'ses_logging_int',
      workDir,
    });

    log.warn('session diagnostic', { sessionId: session.id });
    log.warn('untagged event');

    // Drain the in-process logger via export's flush path is overkill; just
    // rely on the configured root logger's flush.
    const summary = (await harness.listSessions({ workDir })).find(
      (s) => s.id === session.id,
    )!;

    const globalPath = join(homeDir, 'logs', 'kimi-code.log');
    const sessionLogPath = join(summary.sessionDir, 'logs', 'kimi-code.log');

    // Trigger an export — this flushes both global and session via KimiCore
    const exportOut = join(workDir, 'out.zip');
    await harness.exportSession({
      id: session.id,
      outputPath: exportOut,
      includeGlobalLog: true,
      version: '1.0.0-test',
    });

    const global = await readFile(globalPath, 'utf-8');
    const sessionLog = await readFile(sessionLogPath, 'utf-8');
    expect(global).not.toContain('session diagnostic');
    expect(sessionLog).toContain('session diagnostic');
    expect(global).toContain('untagged event');
    expect(sessionLog).not.toContain('untagged event');
  });

  it('default export bundles session log only; no globalLogPath in manifest', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({ id: 'ses_default_export', workDir });
    log.warn('session export marker', { sessionId: session.id });

    const outputPath = join(workDir, 'default.zip');
    const result = await harness.exportSession({ id: session.id, outputPath, version: '1.0.0-test' });

    const zipBuf = await readFile(result.zipPath);
    const entries = readZipEntries(zipBuf);
    expect(entries.has('agents/main/wire.jsonl')).toBe(true);
    expect(entries.has('logs/kimi-code.log')).toBe(true);
    expect(entries.has('logs/global/kimi-code.log')).toBe(false);
    expect(entries.get('logs/kimi-code.log')!.toString('utf-8')).toContain(
      'session export marker',
    );
    expect(result.manifest.sessionLogPath).toBe('logs/kimi-code.log');
    expect(result.manifest.globalLogPath).toBeUndefined();
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as Record<
      string,
      unknown
    >;
    expect(manifest['sessionLogPath']).toBe('logs/kimi-code.log');
    expect(manifest['globalLogPath']).toBeUndefined();
  });

  it('default export works when no session log file exists', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({ id: 'ses_no_session_log', workDir });

    const outputPath = join(workDir, 'no-log.zip');
    const result = await harness.exportSession({ id: session.id, outputPath, version: '1.0.0-test' });

    const entries = readZipEntries(await readFile(result.zipPath));
    expect(entries.has('agents/main/wire.jsonl')).toBe(true);
    expect(entries.has('logs/kimi-code.log')).toBe(false);
    expect(result.manifest.sessionLogPath).toBeUndefined();
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as Record<
      string,
      unknown
    >;
    expect(manifest['sessionLogPath']).toBeUndefined();
  });

  it('default export includes rotated session log files without requiring active kimi-code.log', async () => {
    const env = snapshotLogEnv();
    process.env['KIMI_LOG_LEVEL'] = 'warn';
    process.env['KIMI_LOG_SESSION_MAX_BYTES'] = '1024';
    process.env['KIMI_LOG_SESSION_FILES'] = '2';
    try {
      const homeDir = await makeTempDir('kimi-log-home-');
      const workDir = await makeTempDir('kimi-log-work-');
      const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
      const session = await harness.createSession({ id: 'ses_rotated_export', workDir });
      for (let i = 0; i < 16; i++) {
        log.warn(`rotated session marker ${i}`, {
          sessionId: session.id,
          chunk: 'x'.repeat(220),
        });
      }

      const result = await harness.exportSession({
        id: session.id,
        outputPath: join(workDir, 'rotated.zip'),
        version: '1.0.0-test',
      });

      const entries = readZipEntries(await readFile(result.zipPath));
      const sessionLogEntries = [...entries.keys()].filter(
        (entry) => entry === 'logs/kimi-code.log' || entry.startsWith('logs/kimi-code.log.'),
      );
      expect(sessionLogEntries.length).toBeGreaterThan(0);
      expect(sessionLogEntries).toContain('logs/kimi-code.log.1');
      expect(entries.has('logs/global/kimi-code.log')).toBe(false);
      if (entries.has('logs/kimi-code.log')) {
        expect(result.manifest.sessionLogPath).toBe('logs/kimi-code.log');
      } else {
        expect(result.manifest.sessionLogPath).toBeUndefined();
      }
    } finally {
      restoreLogEnv(env);
    }
  });

  it('--include-global-log bundles global active and sets manifest field', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({ id: 'ses_global_export', workDir });
    log.warn('untagged probe');

    const outputPath = join(workDir, 'with-global.zip');
    const result = await harness.exportSession({
      id: session.id,
      outputPath,
      includeGlobalLog: true,
      version: '1.0.0-test',
    });
    const zipBuf = await readFile(result.zipPath);
    const entries = readZipEntries(zipBuf);
    expect(entries.has('agents/main/wire.jsonl')).toBe(true);
    expect(entries.has('logs/global/kimi-code.log')).toBe(true);
    expect(result.manifest.globalLogPath).toBe('logs/global/kimi-code.log');
    // Global log carries entries that don't have a sessionId routed to a sink.
    expect(entries.get('logs/global/kimi-code.log')!.toString('utf-8')).toContain(
      'untagged probe',
    );
  });

  it('--include-global-log bundles the active root global log path', async () => {
    const firstHome = await makeTempDir('kimi-log-home-a-');
    const secondHome = await makeTempDir('kimi-log-home-b-');
    const workDir = await makeTempDir('kimi-log-work-');
    const first = createKimiHarness({ identity: TEST_IDENTITY, homeDir: firstHome });
    const firstSession = await first.createSession({ id: 'ses_first_global_export', workDir });
    const second = createKimiHarness({ identity: TEST_IDENTITY, homeDir: secondHome });

    log.warn('active-global-export-marker');
    await getRootLogger().flushGlobal();

    const result = await first.exportSession({
      id: firstSession.id,
      outputPath: join(workDir, 'active-global.zip'),
      includeGlobalLog: true,
      version: '1.0.0-test',
    });

    const entries = readZipEntries(await readFile(result.zipPath));
    const globalLog = entries.get('logs/global/kimi-code.log')!.toString('utf-8');
    const firstLog = await readOptionalFile(join(firstHome, 'logs', 'kimi-code.log'));
    expect(globalLog).toContain('active-global-export-marker');
    expect(firstLog).not.toContain('active-global-export-marker');

    await first.close();
    await second.close();
  });

  it('logs export flush failures without failing the export', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({ id: 'ses_flush_warning', workDir });
    log.warn('flush warning setup', { sessionId: session.id });
    log.warn('global untagged marker');

    const root = getRootLogger();
    const flushSessionSpy = vi
      .spyOn(root, 'flushSession')
      .mockRejectedValueOnce(new Error('session flush boom'));
    const flushGlobalSpy = vi
      .spyOn(root, 'flushGlobal')
      .mockRejectedValueOnce(new Error('global flush boom'));
    try {
      const result = await harness.exportSession({
        id: session.id,
        outputPath: join(workDir, 'flush-warning.zip'),
        includeGlobalLog: true,
        version: '1.0.0-test',
      });

      const entries = readZipEntries(await readFile(result.zipPath));
      const sessionLog = entries.get('logs/kimi-code.log')!.toString('utf-8');
      const globalLog = entries.get('logs/global/kimi-code.log')!.toString('utf-8');
      expect(sessionLog).toContain('export session log flush failed');
      expect(sessionLog).toContain('export global log flush failed');
      expect(globalLog).toContain('global untagged marker');
      expect(globalLog).not.toContain('export global log flush failed');
    } finally {
      flushSessionSpy.mockRestore();
      flushGlobalSpy.mockRestore();
    }
  });

  it('multiple KimiHarness constructions in the same process do not throw', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
  });

  it('uses the latest harness homeDir for global diagnostic logging', async () => {
    const firstHome = await makeTempDir('kimi-log-home-a-');
    const secondHome = await makeTempDir('kimi-log-home-b-');
    const first = createKimiHarness({ identity: TEST_IDENTITY, homeDir: firstHome });
    const second = createKimiHarness({ identity: TEST_IDENTITY, homeDir: secondHome });

    log.warn('second-home-marker');
    await getRootLogger().flushGlobal();

    const firstLog = await readOptionalFile(join(firstHome, 'logs', 'kimi-code.log'));
    const secondLog = await readFile(join(secondHome, 'logs', 'kimi-code.log'), 'utf-8');
    expect(firstLog).not.toContain('second-home-marker');
    expect(secondLog).toContain('second-home-marker');

    await first.close();
    await second.close();
  });

  it('SDK does not expose RootLogger / getRootLogger / LoggingConfig', async () => {
    // Type-level check — if these names show up on the SDK index they must
    // be re-exports we forgot to filter. Use string keys so the assertion is
    // structural and survives renames.
    const sdk = await import('#/index');
    const exposed = Object.keys(sdk);
    expect(exposed).toContain('log');
    expect(exposed).toContain('redact');
    expect(exposed).toContain('flushDiagnosticLogs');
    expect(exposed).not.toContain('getLogger');
    expect(exposed).not.toContain('getRootLogger');
    expect(exposed).not.toContain('resolveLoggingConfig');
    expect(exposed).not.toContain('installProcessCrashHandlers');
  });

  it('checks that an empty session log directory does not get a log file', async () => {
    // Sanity: if level is off, no log files should be created
    const env = snapshotLogEnv();
    process.env['KIMI_LOG_LEVEL'] = 'off';
    try {
      const homeDir = await makeTempDir('kimi-log-home-');
      const workDir = await makeTempDir('kimi-log-work-');
      const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
      await harness.createSession({ id: 'ses_off', workDir });
      log.error('this should not write');
      let logsDir: string[] = [];
      try {
        logsDir = await readdir(join(homeDir, 'logs'));
      } catch {
        // intentional — directory may not exist when level=off
      }
      expect(logsDir).not.toContain('kimi-code.log');
    } finally {
      restoreLogEnv(env);
    }
  });

  it('KimiHarness.close() flushes the global log', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    log.warn('untagged before close');
    // No `await flush()` here on purpose — close() must do it.
    await harness.close();
    const globalPath = join(homeDir, 'logs', 'kimi-code.log');
    const text = await readFile(globalPath, 'utf-8');
    expect(text).toContain('untagged before close');
  });
});
