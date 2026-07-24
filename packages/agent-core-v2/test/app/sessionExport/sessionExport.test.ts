import {
  appendFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename, dirname, join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import { Disposable, DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import {
  createServices,
  type ServiceRegistration,
  type TestInstantiationService,
} from '#/_base/di/test';
import { LifecycleScope, type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { ILogService, type ILogService as LogService } from '#/_base/log/log';
import { IWireService } from '#/wire/wire';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { openZipSource, type ZipSource } from '#/app/sessionExport/file-source';
import {
  type ExportSessionManifest,
  ISessionExportService,
} from '#/app/sessionExport/sessionExport';
import {
  exportSessionDirectory,
  SessionExportService,
} from '#/app/sessionExport/sessionExportService';
import { writeExportZip } from '#/app/sessionExport/zip';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionLifecycleService,
  type SessionLifecycleHooks,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubAgentWire } from '../../wire/stubs';

const fsOpenHook = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string, handle: FileHandle) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      await fsOpenHook.afterOpen?.(String(args[0]), handle);
      return handle;
    },
  };
});

const noopDisposable: IDisposable = { dispose: () => {} };
const noopEvent = () => noopDisposable;

describe('sessionExport', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('exports a v2 session directory with per-agent wire activity and optional global log', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_demo');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), '{"msg":"session"}\n', 'utf-8');
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', time: 1_700_000_000_000 }),
        JSON.stringify({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'hello' }),
      ].join('\n'),
      'utf-8',
    );
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(globalLogPath, '{"msg":"global"}\n', 'utf-8');

    const outputPath = join(tmp, 'export.zip');
    const result = await exportSessionDirectory({
      request: {
        sessionId: 'ses_demo',
        outputPath,
        includeGlobalLog: true,
        version: '1.0.0-test',
      },
      summary: {
        id: 'ses_demo',
        title: 'Demo',
        workspaceDir: '/workspace/demo',
        sessionDir,
      },
      globalLogPath,
    });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.entries).toEqual([
      'manifest.json',
      'agents/main/wire.jsonl',
      'logs/kimi-code.log',
      'state.json',
      'logs/global/kimi-code.log',
    ]);
    expect(result.manifest).toMatchObject({
      sessionId: 'ses_demo',
      kimiCodeVersion: '1.0.0-test',
      title: 'Demo',
      workspaceDir: '/workspace/demo',
      sessionFirstActivity: '2023-11-14T22:13:20.000Z',
      sessionLastActivity: '2023-11-14T22:13:25.000Z',
      sessionLogPath: 'logs/kimi-code.log',
      globalLogPath: 'logs/global/kimi-code.log',
    });
  });

  it('uses a timestamped default output path when outputPath is omitted', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_default_output');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');

    const result = await exportSessionDirectory({
      request: { sessionId: 'ses_default_output', version: '1.0.0-test' },
      summary: { id: 'ses_default_output', sessionDir },
    });

    try {
      expect(dirname(result.zipPath)).toBe(resolve('.'));
      expect(basename(result.zipPath)).toMatch(/^kimi-debug-ses_defa-\d{8}-\d{6}\.zip$/);
      await expect(stat(result.zipPath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await rm(result.zipPath, { force: true });
    }
  });

  it('does not overwrite a previous default-path export when run again', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_repeated_export');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const summary = { id: 'ses_repeated_export', sessionDir };

    const first = await exportSessionDirectory({
      request: { sessionId: 'ses_repeated_export', version: '1.0.0-test' },
      summary,
    });
    // Cross the next second boundary so the second export gets a distinct timestamp.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100 - (Date.now() % 1000)));
    const second = await exportSessionDirectory({
      request: { sessionId: 'ses_repeated_export', version: '1.0.0-test' },
      summary,
    });

    try {
      expect(second.zipPath).not.toBe(first.zipPath);
      await expect(stat(first.zipPath)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(stat(second.zipPath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await rm(first.zipPath, { force: true });
      await rm(second.zipPath, { force: true });
    }
  });

  it('keeps the session log bound when it rotates as wire scanning starts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_rotating_log');
    const logPath = join(sessionDir, 'logs', 'kimi-code.log');
    const rotatedPath = `${logPath}.1`;
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const outputPath = join(tmp, 'rotating-log.zip');
    const log = Buffer.from('session log before rotation\n', 'utf8');
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf8');
    await writeFile(logPath, log);
    await writeFile(wirePath, `${JSON.stringify({ type: 'metadata', time: 1_700_000_000 })}\n`);
    let rotated = false;
    fsOpenHook.afterOpen = async (path) => {
      if (!rotated && path === wirePath) {
        await rename(logPath, rotatedPath);
        rotated = true;
      }
    };

    try {
      const result = await exportSessionDirectory({
        request: {
          sessionId: 'ses_rotating_log',
          outputPath,
          version: '1.0.0-test',
        },
        summary: {
          id: 'ses_rotating_log',
          sessionDir,
        },
      });

      expect(rotated).toBe(true);
      expect(result.manifest.sessionLogPath).toBe('logs/kimi-code.log');
      expect(result.entries).toContain('logs/kimi-code.log');
      await expect(readZipEntry(outputPath, 'logs/kimi-code.log')).resolves.toEqual(log);
    } finally {
      fsOpenHook.afterOpen = undefined;
    }
  });

  it('keeps the global log bound when it rotates as wire scanning starts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_rotating_global');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    const rotatedPath = `${globalLogPath}.1`;
    const outputPath = join(tmp, 'rotating-global.zip');
    const log = Buffer.from('global log before rotation\n', 'utf8');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf8');
    await writeFile(wirePath, `${JSON.stringify({ type: 'metadata', time: 1_700_000_000 })}\n`);
    await writeFile(globalLogPath, log);
    let rotated = false;
    fsOpenHook.afterOpen = async (path) => {
      if (!rotated && path === wirePath) {
        await rename(globalLogPath, rotatedPath);
        rotated = true;
      }
    };

    try {
      const result = await exportSessionDirectory({
        request: {
          sessionId: 'ses_rotating_global',
          outputPath,
          includeGlobalLog: true,
          version: '1.0.0-test',
        },
        summary: {
          id: 'ses_rotating_global',
          sessionDir,
        },
        globalLogPath,
      });

      expect(rotated).toBe(true);
      expect(result.manifest.globalLogPath).toBe('logs/global/kimi-code.log');
      expect(result.entries).toContain('logs/global/kimi-code.log');
      await expect(readZipEntry(outputPath, 'logs/global/kimi-code.log')).resolves.toEqual(log);
    } finally {
      fsOpenHook.afterOpen = undefined;
    }
  });

  it('closes pre-opened logs when manifest creation fails before writer ownership', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_invalid_manifest');
    const sessionLogPath = join(sessionDir, 'logs', 'kimi-code.log');
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const outputPath = join(tmp, 'invalid-manifest.zip');
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf8');
    await writeFile(sessionLogPath, 'session log\n', 'utf8');
    await writeFile(globalLogPath, 'global log\n', 'utf8');
    await writeFile(
      wirePath,
      `${JSON.stringify({ type: 'metadata', time: 9_000_000_000_000_001 })}\n`,
    );
    const logHandles: FileHandle[] = [];
    fsOpenHook.afterOpen = async (path, handle) => {
      if (path === sessionLogPath || path === globalLogPath) logHandles.push(handle);
    };

    try {
      await expect(
        exportSessionDirectory({
          request: {
            sessionId: 'ses_invalid_manifest',
            outputPath,
            includeGlobalLog: true,
            version: '1.0.0-test',
          },
          summary: {
            id: 'ses_invalid_manifest',
            sessionDir,
          },
          globalLogPath,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    } finally {
      fsOpenHook.afterOpen = undefined;
    }

    expect(logHandles).toHaveLength(2);
    for (const handle of logHandles) {
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    }
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(tmp)).filter((entry) => entry.startsWith('.kimi-session-export-'))).toEqual(
      [],
    );
  });

  it('omits the optional global log when the configured file is missing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_unreadable_global');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');

    const outputPath = join(tmp, 'unreadable-global.zip');
    const result = await exportSessionDirectory({
      request: {
        sessionId: 'ses_unreadable_global',
        outputPath,
        includeGlobalLog: true,
        version: '1.0.0-test',
      },
      summary: {
        id: 'ses_unreadable_global',
        workspaceDir: '/workspace/demo',
        sessionDir,
      },
      globalLogPath,
    });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.manifest.globalLogPath).toBeUndefined();
    expect(result.entries).not.toContain('logs/global/kimi-code.log');
  });

  it('archives more than 300 session files without exhausting file handles', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionFiles: string[] = [];
    for (let index = 0; index < 320; index += 1) {
      const path = join(tmp, `entry-${index.toString().padStart(3, '0')}.txt`);
      await writeFile(path, `${index}\n`, 'utf8');
      sessionFiles.push(path);
    }

    const entries = await writeExportZip({
      outputPath: join(tmp, 'many-files.zip'),
      manifest: testManifest('ses_many_files'),
      sessionDir: tmp,
      sessionFiles,
    });

    expect(entries).toHaveLength(321);
    await expect(readZipEntry(join(tmp, 'many-files.zip'), 'entry-319.txt')).resolves.toEqual(
      Buffer.from('319\n', 'utf8'),
    );
  });

  it('rejects an output path that is also a selected session file without modifying it', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const outputPath = join(tmp, 'state.json');
    const original = Buffer.from('{"state":"preserved"}\n', 'utf8');
    await writeFile(outputPath, original);

    await expect(
      exportSessionDirectory({
        request: {
          sessionId: 'ses_output_conflict',
          outputPath,
          version: '1.0.0-test',
        },
        summary: {
          id: 'ses_output_conflict',
          sessionDir: tmp,
        },
      }),
    ).rejects.toMatchObject({
      name: 'Error2',
      code: 'session.export_output_conflict',
      details: { outputPath, source: outputPath },
    });
    await expect(readFile(outputPath)).resolves.toEqual(original);
  });

  it('rejects a hard-linked output path without modifying the selected session file', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sourcePath = join(tmp, 'state.json');
    const outputPath = join(tmp, 'export.zip');
    const original = Buffer.from('{"state":"preserved"}\n', 'utf8');
    await writeFile(sourcePath, original);
    await link(sourcePath, outputPath);

    await expect(
      writeExportZip({
        outputPath,
        manifest: testManifest('ses_hard_link_conflict'),
        sessionDir: tmp,
        sessionFiles: [sourcePath],
      }),
    ).rejects.toMatchObject({ code: 'session.export_output_conflict' });
    await expect(readFile(sourcePath)).resolves.toEqual(original);
  });

  it('closes a pre-opened source when it conflicts with the output path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const outputPath = join(tmp, 'global.log');
    const original = Buffer.from('global log\n', 'utf8');
    await writeFile(outputPath, original);
    const opened = await openZipSource(outputPath);
    let closeCalls = 0;
    const source: ZipSource = {
      ...opened,
      close: async () => {
        closeCalls += 1;
        await opened.close();
      },
    };

    await expect(
      writeExportZip({
        outputPath,
        manifest: testManifest('ses_extra_conflict'),
        sessionDir: tmp,
        sessionFiles: [],
        extraEntries: [{ source, target: 'logs/global/kimi-code.log' }],
      }),
    ).rejects.toMatchObject({ code: 'session.export_output_conflict' });
    expect(closeCalls).toBe(1);
    await expect(readFile(outputPath)).resolves.toEqual(original);
  });

  it('archives a bound session log after its path is rotated', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const logPath = join(tmp, 'logs', 'kimi-code.log');
    const rotatedPath = `${logPath}.1`;
    const outputPath = join(tmp, 'rotated-log.zip');
    const original = Buffer.from('before rotation\n', 'utf8');
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(logPath, original);
    const opened = await openZipSource(logPath);
    let closeCalls = 0;
    const source: ZipSource = {
      ...opened,
      close: async () => {
        closeCalls += 1;
        await opened.close();
      },
    };
    await rename(logPath, rotatedPath);

    await expect(
      writeExportZip({
        outputPath,
        manifest: testManifest('ses_rotated_log'),
        sessionDir: tmp,
        sessionFiles: [{ path: logPath, source }],
      }),
    ).resolves.toContain('logs/kimi-code.log');
    await expect(readZipEntry(outputPath, 'logs/kimi-code.log')).resolves.toEqual(original);
    expect(closeCalls).toBe(1);
  });

  it('includes a bounded Web log in the exported archive', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_web_log');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const webLog = [
      JSON.stringify({ event: 'websocket.connected', time: 1 }),
      JSON.stringify({ event: 'prompt.submitted', time: 2 }),
    ].join('\n');
    const outputPath = join(tmp, 'web-log.zip');

    const result = await exportSessionDirectory({
      request: {
        sessionId: 'ses_web_log',
        outputPath,
        version: '1.0.0-test',
      },
      summary: {
        id: 'ses_web_log',
        sessionDir,
      },
      webLog,
    });

    expect(result.entries).toContain('logs/kimi-web.jsonl');
    expect(result.manifest.webLogPath).toBe('logs/kimi-web.jsonl');
    await expect(readZipEntry(outputPath, 'logs/kimi-web.jsonl')).resolves.toEqual(
      Buffer.from(webLog, 'utf8'),
    );
  });

  it('rejects when a collected file disappears before it can be archived', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const removedPath = join(tmp, 'removed-state.json');
    await writeFile(removedPath, 'remove me\n', 'utf8');
    await unlink(removedPath);

    await expect(
      writeExportZip({
        outputPath: join(tmp, 'missing-file.zip'),
        manifest: testManifest('ses_missing_file'),
        sessionDir: tmp,
        sessionFiles: [removedPath],
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(tmp)).resolves.toEqual([]);
  });

  it('archives the opened file size when the source is appended during compression', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const livePath = join(tmp, 'live.log');
    const outputPath = join(tmp, 'append.zip');
    const initialContent = Buffer.from('before\n', 'utf8');
    await writeFile(livePath, initialContent);
    const source = await openZipSource(livePath);
    await appendFile(livePath, 'after\n', 'utf8');

    await expect(
      writeExportZip({
        outputPath,
        manifest: testManifest('ses_append'),
        sessionDir: tmp,
        sessionFiles: [],
        extraEntries: [{ source, target: 'live.log' }],
      }),
    ).resolves.toContain('live.log');

    await expect(readZipEntry(outputPath, 'live.log')).resolves.toEqual(initialContent);
  });

  it('destroys and closes the active source when compression is aborted', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const outputPath = join(tmp, 'aborted.zip');
    const abort = new AbortController();
    const readStarted = deferred();
    const allowRead = deferred();
    let reading = false;
    const stream = new Readable({
      read() {
        if (reading) return;
        reading = true;
        readStarted.resolve();
        void allowRead.promise.then(() => {
          if (this.destroyed) return;
          this.push(Buffer.from('payload', 'utf8'));
          this.push(null);
        });
      },
    });
    let closeCalls = 0;
    let closed = false;
    const source: ZipSource = {
      stream,
      size: 7,
      mtime: new Date(0),
      mode: 0o600,
      identity: { device: -1n, inode: -1n },
      close: async () => {
        if (closed) return;
        closed = true;
        closeCalls += 1;
        stream.destroy();
      },
    };

    const writing = writeExportZip({
      outputPath,
      manifest: testManifest('ses_abort'),
      sessionDir: tmp,
      sessionFiles: [],
      extraEntries: [{ source, target: 'controlled.bin' }],
      signal: abort.signal,
    });
    await readStarted.promise;
    abort.abort(new DOMException('test abort', 'AbortError'));

    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.destroyed).toBe(true);
    expect(closeCalls).toBe(1);
    allowRead.resolve();
    await expect(readdir(tmp)).resolves.toEqual([]);
  });

  it('does not follow an output symlink swapped during compression', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const statePath = join(tmp, 'state.json');
    const safeTarget = join(tmp, 'safe-output');
    const outputPath = join(tmp, 'export.zip');
    const state = Buffer.from('{"state":"preserved"}\n', 'utf8');
    await writeFile(statePath, state);
    await writeFile(safeTarget, 'safe\n', 'utf8');
    await symlink(safeTarget, outputPath);
    const readStarted = deferred();
    const allowRead = deferred();
    const payload = Buffer.from('payload', 'utf8');
    const stream = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        readStarted.resolve();
        await allowRead.promise;
        yield payload;
      })(),
    );
    const source: ZipSource = {
      stream,
      size: payload.length,
      mtime: new Date(0),
      mode: 0o600,
      identity: { device: -1n, inode: -1n },
      close: async () => {
        stream.destroy();
      },
    };

    const writing = writeExportZip({
      outputPath,
      manifest: testManifest('ses_symlink_swap'),
      sessionDir: tmp,
      sessionFiles: [],
      extraEntries: [{ source, target: 'controlled.bin' }],
    });
    await readStarted.promise;
    await unlink(outputPath);
    await symlink(statePath, outputPath);
    allowRead.resolve();
    await writing;

    await expect(readFile(statePath)).resolves.toEqual(state);
    await expect(readFile(safeTarget, 'utf8')).resolves.toBe('safe\n');
    expect((await lstat(outputPath)).isSymbolicLink()).toBe(false);
    await expect(readZipEntry(outputPath, 'controlled.bin')).resolves.toEqual(payload);
    expect((await readdir(tmp)).toSorted()).toEqual(['export.zip', 'safe-output', 'state.json']);
  });

  it('rejects with a coded error when compressed output exceeds the configured limit', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));

    await expect(
      writeExportZip({
        outputPath: join(tmp, 'too-large.zip'),
        manifest: testManifest('ses_too_large'),
        sessionDir: tmp,
        sessionFiles: [],
        maxArchiveBytes: 1,
      }),
    ).rejects.toMatchObject({
      code: 'session.export_too_large',
      details: { maxArchiveBytes: 1 },
    });
  });

  it('throws a coded error when the session is unknown', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    ix = createTestServices(tmp, {
      summary: undefined,
      lifecycleHandle: undefined,
    });

    await expect(
      ix.get(ISessionExportService).export({
        sessionId: 'ses_missing',
        version: '1.0.0-test',
      }),
    ).rejects.toMatchObject({
      name: 'Error2',
      code: 'session.not_found',
      details: { sessionId: 'ses_missing' },
    } satisfies Partial<Error2>);
  });

  it('flushes live session and agent state before packaging', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_live', 'ses_live');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const outputPath = join(tmp, 'live.zip');
    let sessionLogFlushes = 0;
    let agentWireFlushes = 0;
    const liveHandle = liveSessionHandle({
      meta: {
        id: 'ses_live',
        title: 'Fresh title',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
      sessionLog: {
        ...stubLog(),
        flush: async () => {
          sessionLogFlushes += 1;
        },
      },
      agentWire: {
        flush: async () => {
          agentWireFlushes += 1;
        },
      },
    });
    ix = createTestServices(tmp, {
      summary: {
        id: 'ses_live',
        workspaceId: 'ws_live',
        title: 'Stale title',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      },
      lifecycleHandle: liveHandle,
    });

    const result = await ix.get(ISessionExportService).export({
      sessionId: 'ses_live',
      outputPath,
      version: '1.0.0-test',
    });

    expect(sessionLogFlushes).toBe(1);
    expect(agentWireFlushes).toBe(1);
    expect(result.manifest.title).toBe('Fresh title');
    expect(result.entries).toContain('state.json');
  });

  it('continues exporting when live flushes fail', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_live', 'ses_flush_failure');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const outputPath = join(tmp, 'flush-failure.zip');
    const warnings: string[] = [];
    const liveHandle = liveSessionHandle({
      meta: {
        id: 'ses_flush_failure',
        title: 'Fresh title',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
      sessionLog: {
        ...stubLog(),
        flush: async () => {
          throw new Error('session log flush failed');
        },
      },
      agentWire: {
        flush: async () => {
          throw new Error('agent wire flush failed');
        },
      },
    });
    ix = createTestServices(tmp, {
      summary: {
        id: 'ses_flush_failure',
        workspaceId: 'ws_live',
        title: 'Stale title',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      },
      lifecycleHandle: liveHandle,
      appLog: {
        ...stubLog(),
        warn: (message) => {
          warnings.push(message);
        },
        flush: async () => {
          throw new Error('global log flush failed');
        },
      },
    });

    const result = await ix.get(ISessionExportService).export({
      sessionId: 'ses_flush_failure',
      outputPath,
      includeGlobalLog: true,
      version: '1.0.0-test',
    });

    expect(result.manifest.title).toBe('Fresh title');
    expect(result.entries).toContain('state.json');
    expect(result.manifest.globalLogPath).toBeUndefined();
    expect(warnings).toEqual([
      'export session log flush failed',
      'export agent wire flush failed',
      'export global log flush failed',
    ]);
  });

  function createTestServices(
    homeDir: string,
    options: {
      readonly summary: SessionSummary | undefined;
      readonly lifecycleHandle: ISessionScopeHandle | undefined;
      readonly appLog?: LogService;
    },
  ): TestInstantiationService {
    return createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerSessionExportServices(reg, homeDir, options);
      },
    });
  }
});

function registerSessionExportServices(
  reg: ServiceRegistration,
  homeDir: string,
  options: {
    readonly summary: SessionSummary | undefined;
    readonly lifecycleHandle: ISessionScopeHandle | undefined;
    readonly appLog?: LogService;
  },
): void {
  reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
  reg.defineInstance(ILogService, options.appLog ?? stubLog());
  reg.defineInstance(ISessionIndex, {
    _serviceBrand: undefined,
    list: async () => ({ items: options.summary === undefined ? [] : [options.summary] }),
    get: async () => options.summary,
    countActive: async () => (options.summary === undefined || options.summary.archived ? 0 : 1),
  });
  reg.defineInstance(ISessionLifecycleService, {
    _serviceBrand: undefined,
    onDidCreateSession: noopEvent,
    onDidCloseSession: noopEvent,
    onDidArchiveSession: noopEvent,
    onDidForkSession: noopEvent,
    hooks: createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]),
    create: async () => {
      throw new Error('create should not be called by session export');
    },
    get: () => options.lifecycleHandle,
    list: () => (options.lifecycleHandle === undefined ? [] : [options.lifecycleHandle]),
    resume: async () => options.lifecycleHandle,
    close: async () => {},
    archive: async () => {},
    restore: async () => options.lifecycleHandle,
    fork: async () => {
      throw new Error('fork should not be called by session export');
    },
    createChild: async () => {
      throw new Error('createChild should not be called by session export');
    },
  });
  reg.defineInstance(IWorkspaceService, {
    _serviceBrand: undefined,
    list: async () => [],
    get: async (id) => ({
      id,
      root: `/workspaces/${id}`,
      name: id,
      createdAt: 1,
      lastOpenedAt: 2,
    }),
    createOrTouch: async (root) => ({
      id: 'ws_created',
      root,
      name: 'created',
      createdAt: 1,
      lastOpenedAt: 2,
    }),
    update: async () => undefined,
    delete: async () => {},
  });
  reg.define(ISessionExportService, SessionExportService);
}

function liveSessionHandle(options: {
  readonly meta: SessionMeta;
  readonly sessionLog: LogService;
  readonly agentWire: Pick<ReturnType<typeof stubAgentWire>, 'flush'>;
}): ISessionScopeHandle {
  const agentHandle = testAgentHandle(options.agentWire);
  const lifecycle = stubAgentLifecycle([agentHandle]);
  return {
    id: options.meta.id,
    kind: LifecycleScope.Session,
    accessor: accessorFrom([
      [ISessionMetadata, stubSessionMetadata(options.meta)],
      [ILogService, options.sessionLog],
      [IAgentLifecycleService, lifecycle],
    ]),
    dispose: () => {},
  };
}

function testAgentHandle(agentWire: Pick<ReturnType<typeof stubAgentWire>, 'flush'>): IAgentScopeHandle {
  return {
    id: 'main',
    kind: LifecycleScope.Agent,
    accessor: accessorFrom([[IWireService, stubAgentWire(agentWire.flush)]]),
    dispose: () => {},
  };
}

function accessorFrom(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  const services = new Map<ServiceIdentifier<unknown>, unknown>(entries);
  return {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (!services.has(id as ServiceIdentifier<unknown>)) {
        throw new Error(`missing test service ${String(id)}`);
      }
      return services.get(id as ServiceIdentifier<unknown>) as T;
    },
  };
}

function stubSessionMetadata(meta: SessionMeta): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: noopEvent,
    read: async () => meta,
    update: async () => {},
    setTitle: async () => {},
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function stubAgentLifecycle(agents: readonly IAgentScopeHandle[]): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: noopEvent,
    onDidDispose: noopEvent,
    create: async () => agents[0]!,
    fork: async () => agents[0]!,
    get: (agentId) => agents.find((agent) => agent.id === agentId),
    list: () => agents,
    remove: async () => {},
    broadcastPermissionMode: () => {},
  };
}
function testManifest(sessionId: string): ExportSessionManifest {
  return {
    sessionId,
    exportedAt: '2026-01-01T00:00:00.000Z',
    kimiCodeVersion: '1.0.0-test',
    wireProtocolVersion: '1',
    os: 'test',
    nodejsVersion: 'test',
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readZipEntry(path: string, target: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    openZip(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null) {
        reject(openError);
        return;
      }

      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };

      zip.once('error', fail);
      zip.on('entry', (entry) => {
        if (entry.fileName !== target) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null) {
            fail(streamError);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', fail);
          stream.once('end', () => {
            if (settled) return;
            settled = true;
            zip.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zip.once('end', () => {
        fail(new Error(`zip entry not found: ${target}`));
      });
      zip.readEntry();
    });
  });
}
