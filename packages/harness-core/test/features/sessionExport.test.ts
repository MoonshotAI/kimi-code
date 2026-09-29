import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { basename, dirname, join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import {
  memorySessionSpace,
  createHarness,
  SessionSpaceError,
  type AppHandle,
  type SessionSpace,
} from '@moonshot-ai/agent-core';

import {
  createSessionExport,
  scanSessionJournal,
  SessionExportError,
  SessionExportRef,
  type CreateSessionExportProps,
  type SessionExportFace,
} from '#/features/sessionExport/index';
import { createHttp, HttpRef } from '#/feature-http/index';

const SESSION_ID = 'ses_demo';

const tmps: string[] = [];
const apps: AppHandle[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
  await Promise.all(tmps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-export-test-'));
  tmps.push(dir);
  return dir;
}

async function makeSessionDir(root: string, files: Readonly<Record<string, string>>): Promise<string> {
  const sessionDir = join(root, 'sessions', SESSION_ID);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(sessionDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return sessionDir;
}

async function mountExport(
  space: SessionSpace,
  dirs: ReadonlyMap<string, string>,
  props?: Partial<CreateSessionExportProps>,
): Promise<SessionExportFace> {
  const app = createHarness({
    space,
    features: [
      createSessionExport({
        version: '1.0.0-test',
        wireProtocolVersion: '1',
        ...props,
        sessionDir: (sessionId) => dirs.get(sessionId),
      }),
    ],
  });
  apps.push(app);
  await app.ready();
  return app.resolve(SessionExportRef);
}

async function writeJournal(
  sessionDir: string,
  tree: string,
  branch: string,
  entries: readonly { ts: number; type: string; data?: unknown }[],
): Promise<void> {
  const header = JSON.stringify({ kind: 'header', version: 1, tree, branch, createdAt: 1 });
  const lines = entries.map((entry, seq) =>
    JSON.stringify({
      kind: 'entry',
      seq,
      ts: entry.ts,
      type: entry.type,
      payload: { kind: 'json', size: 0, data: entry.data ?? null },
    }),
  );
  const dir = join(sessionDir, 'trees', tree);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${branch}.jsonl`), `${[header, ...lines].join('\n')}\n`, 'utf8');
}

function messageAppended(role: 'user' | 'assistant', text: string): unknown {
  return {
    type: 'message.appended',
    message: { message: { role, content: [{ type: 'text', text }] } },
  };
}

describe('sessionExport feature', () => {
  it('exports a session directory with journal activity in the manifest', async () => {
    const tmp = await makeTmp();
    const sessionDir = await makeSessionDir(tmp, {
      'meta.json': '{"id":"ses_demo"}\n',
      'file-history/blob-1': 'history\n',
    });
    await writeJournal(sessionDir, 'sess', 'main', [
      { ts: 1_700_000_000_000, type: 'turn.started', data: { type: 'turn.started', turnId: 1 } },
      { ts: 1_700_000_005_000, type: 'message.appended', data: messageAppended('user', 'hello') },
      { ts: 1_700_000_010_000, type: 'message.appended', data: messageAppended('assistant', 'hi') },
    ]);
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const face = await mountExport(space, new Map([[SESSION_ID, sessionDir]]));
    const outputPath = join(tmp, 'export.zip');

    const result = await face.export({ sessionId: SESSION_ID, outputPath });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.entries).toEqual(['manifest.json', 'meta.json', 'trees/sess/main.jsonl']);
    expect(result.manifest).toMatchObject({
      sessionId: SESSION_ID,
      kimiCodeVersion: '1.0.0-test',
      wireProtocolVersion: '1',
      os: `${process.platform} ${process.arch}`,
      nodejsVersion: process.version.replace(/^v/, ''),
      title: 'Demo',
      sessionFirstActivity: '2023-11-14T22:13:20.000Z',
      sessionLastActivity: '2023-11-14T22:13:30.000Z',
    });
    await expect(readZipEntry(outputPath, 'meta.json')).resolves.toEqual(
      Buffer.from('{"id":"ses_demo"}\n', 'utf8'),
    );
    const scan = await scanSessionJournal(sessionDir);
    expect(scan).toEqual({
      firstActivityMs: 1_700_000_000_000,
      lastActivityMs: 1_700_000_010_000,
      lastUserMessageMs: 1_700_000_005_000,
      firstUserInput: 'hello',
    });
  });

  it('uses a timestamped default output path and never overwrites an earlier export', async () => {
    const tmp = await makeTmp();
    const sessionDir = await makeSessionDir(tmp, { 'meta.json': '{}\n' });
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const face = await mountExport(space, new Map([[SESSION_ID, sessionDir]]));

    const first = await face.export({ sessionId: SESSION_ID });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100 - (Date.now() % 1000)));
    const second = await face.export({ sessionId: SESSION_ID });

    try {
      expect(dirname(first.zipPath)).toBe(resolve('.'));
      expect(basename(first.zipPath)).toMatch(/^kimi-debug-ses_demo-\d{8}-\d{6}\.zip$/);
      expect(second.zipPath).not.toBe(first.zipPath);
      await expect(stat(first.zipPath)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(stat(second.zipPath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await rm(first.zipPath, { force: true });
      await rm(second.zipPath, { force: true });
    }
  });

  it('rejects with a SessionSpaceError when the session is unknown', async () => {
    const face = await mountExport(memorySessionSpace(), new Map());

    const error = await face
      .export({ sessionId: 'ses_missing' })
      .then(
        () => {
          throw new Error('export should have rejected');
        },
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(SessionSpaceError);
    expect(error).toMatchObject({ reason: 'not-found' });
  });

  it('rejects with export_not_found when the session has no exportable directory', async () => {
    const tmp = await makeTmp();
    const emptyDir = await makeSessionDir(tmp, {});
    const space = memorySessionSpace();
    await space.create('ses_nodir', { title: 'No dir' });
    await space.create(SESSION_ID, { title: 'Empty' });
    const face = await mountExport(space, new Map([[SESSION_ID, emptyDir]]));

    await expect(face.export({ sessionId: 'ses_nodir' })).rejects.toMatchObject({
      name: 'SessionExportError',
      code: 'session.export_not_found',
    });
    await expect(face.export({ sessionId: SESSION_ID })).rejects.toMatchObject({
      name: 'SessionExportError',
      code: 'session.export_not_found',
    });
  });

  it('rejects an output path that conflicts with a selected source without modifying it', async () => {
    const tmp = await makeTmp();
    const sessionDir = join(tmp, 'sessions', SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    const outputPath = join(sessionDir, 'state.json');
    const original = Buffer.from('{"state":"preserved"}\n', 'utf8');
    await writeFile(outputPath, original);
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const face = await mountExport(space, new Map([[SESSION_ID, sessionDir]]));

    await expect(face.export({ sessionId: SESSION_ID, outputPath })).rejects.toMatchObject({
      name: 'SessionExportError',
      code: 'session.export_output_conflict',
      details: { outputPath, source: outputPath },
    });
    await expect(readFile(outputPath)).resolves.toEqual(original);
  });

  it('bundles optional global, desktop and web logs and omits a missing global log', async () => {
    const tmp = await makeTmp();
    const sessionDir = await makeSessionDir(tmp, { 'state.json': '{}\n' });
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    const desktopLogPath = join(tmp, 'logs', 'kimi-code-desktop.log');
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(globalLogPath, '{"msg":"global"}\n', 'utf8');
    await writeFile(desktopLogPath, 'desktop log\n', 'utf8');
    const webLog = JSON.stringify({ event: 'websocket.connected', time: 1 });
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const face = await mountExport(space, new Map([[SESSION_ID, sessionDir]]), {
      globalLogPath,
      desktopLogPath,
    });

    const outputPath = join(tmp, 'with-logs.zip');
    const result = await face.export({
      sessionId: SESSION_ID,
      outputPath,
      includeGlobalLog: true,
      includeDesktopLog: true,
      webLog,
    });

    expect(result.entries).toEqual([
      'manifest.json',
      'state.json',
      'logs/kimi-web.jsonl',
      'logs/global/kimi-code.log',
      'logs/kimi-desktop.log',
    ]);
    expect(result.manifest).toMatchObject({
      globalLogPath: 'logs/global/kimi-code.log',
      desktopLogPath: 'logs/kimi-desktop.log',
      webLogPath: 'logs/kimi-web.jsonl',
    });
    await expect(readZipEntry(outputPath, 'logs/global/kimi-code.log')).resolves.toEqual(
      Buffer.from('{"msg":"global"}\n', 'utf8'),
    );
    await expect(readZipEntry(outputPath, 'logs/kimi-desktop.log')).resolves.toEqual(
      Buffer.from('desktop log\n', 'utf8'),
    );
    await expect(readZipEntry(outputPath, 'logs/kimi-web.jsonl')).resolves.toEqual(
      Buffer.from(webLog, 'utf8'),
    );

    await rm(globalLogPath);
    const missing = await face.export({
      sessionId: SESSION_ID,
      outputPath: join(tmp, 'missing-global.zip'),
      includeGlobalLog: true,
    });
    expect(missing.entries).not.toContain('logs/global/kimi-code.log');
    expect(missing.manifest.globalLogPath).toBeUndefined();
  });

  it('rejects when the signal is already aborted', async () => {
    const tmp = await makeTmp();
    const sessionDir = await makeSessionDir(tmp, { 'state.json': '{}\n' });
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const face = await mountExport(space, new Map([[SESSION_ID, sessionDir]]));
    const abort = new AbortController();
    abort.abort();

    await expect(
      face.export({ sessionId: SESSION_ID, signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws a coded error at creation when the host version is blank', () => {
    let caught: unknown;
    try {
      createSessionExport({ version: ' ', sessionDir: () => undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionExportError);
    expect(caught).toMatchObject({
      code: 'session.export_missing_version',
      message: 'Session export requires a host version.',
    });
  });

  it('serves the export over feature-http and reports 40936 when the feature is absent', async () => {
    const tmp = await makeTmp();
    const sessionDir = await makeSessionDir(tmp, { 'meta.json': '{"id":"ses_demo"}\n' });
    const space = memorySessionSpace();
    await space.create(SESSION_ID, { title: 'Demo' });
    const app = createHarness({
      space,
      features: [
        createSessionExport({
          version: '1.0.0-test',
          sessionDir: (sessionId) => (sessionId === SESSION_ID ? sessionDir : undefined),
        }),
        createHttp(),
      ],
    });
    apps.push(app);
    await app.ready();

    const origin = app.resolve(HttpRef).origin;
    const response = await fetch(`${origin}/api/v1/sessions/${SESSION_ID}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="kimi-session-ses_demo.zip"',
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const zipPath = join(tmp, 'http.zip');
    await writeFile(zipPath, bytes);
    const manifest = JSON.parse((await readZipEntry(zipPath, 'manifest.json')).toString('utf8'));
    expect(manifest).toMatchObject({ sessionId: SESSION_ID, kimiCodeVersion: '1.0.0-test' });

    const bare = createHarness({ space: memorySessionSpace(), features: [createHttp()] });
    apps.push(bare);
    await bare.ready();
    const missing = await fetch(`${bare.resolve(HttpRef).origin}/api/v1/sessions/${SESSION_ID}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: 40936 });
  });
});

function readZipEntry(path: string, target: string): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
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
            resolvePromise(Buffer.concat(chunks));
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
