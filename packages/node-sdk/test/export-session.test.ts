import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createKimiHarness,
  KimiError,
  type SessionSummary,
} from '#/index';
import { resolveGlobalLogPath } from '../../agent-core/src/logging/logger';
import {
  WIRE_PROTOCOL_VERSION,
  exportSessionDirectory,
} from '../../agent-core/src/session/export';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-export-'));
  tempDirs.push(dir);
  return dir;
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
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`bad central-directory entry at ${String(pos)}`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnameLen);

    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new Error(`bad local-file-header at ${String(lfhOffset)}`);
    }
    const lfhFnameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data === null) throw new Error(`unsupported compression method: ${String(method)}`);
    entries.set(filename, data);
    pos += 46 + fnameLen + extraLen + commentLen;
  }

  return entries;
}

function makeSummary(input: {
  readonly id: string;
  readonly sessionDir: string;
  readonly workDir: string;
  readonly title?: string | undefined;
}): SessionSummary {
  return {
    id: input.id,
    sessionDir: input.sessionDir,
    workDir: input.workDir,
    createdAt: 1,
    updatedAt: 2,
    title: input.title,
  };
}

describe('exportSessionDirectory', () => {
  it('writes a zip with manifest and every session file', async () => {
    const tmp = await makeTempDir();
    const sid = 'ses_export_test';
    const workDir = join(tmp, 'work');
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(join(sessionDir, 'subagents'), { recursive: true });
    await writeFile(
      join(sessionDir, 'wire.jsonl'),
      [
        JSON.stringify({
          type: 'turn_begin',
          time: Date.parse('2026-04-18T10:00:00Z'),
          user_input: 'hello',
        }),
        JSON.stringify({
          type: 'turn_end',
          time: Date.parse('2026-04-18T10:00:03Z'),
        }),
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ session_id: sid }), 'utf-8');
    await writeFile(join(sessionDir, 'subagents', 'a.txt'), 'child', 'utf-8');

    const outputPath = join(tmp, 'out.zip');
    const result = await exportSessionDirectory({
      request: { sessionId: sid, outputPath, version: '1.0.0-test' },
      summary: makeSummary({
        id: sid,
        sessionDir,
        workDir,
        title: 'Export Test',
      }),
    });

    expect(result.zipPath).toBe(outputPath);
    expect(result.sessionDir).toBe(sessionDir);
    expect(result.entries).toEqual([
      'manifest.json',
      'state.json',
      'subagents/a.txt',
      'wire.jsonl',
    ]);
    expect(result.manifest).toMatchObject({
      sessionId: sid,
      wireProtocolVersion: WIRE_PROTOCOL_VERSION,
      sessionFirstActivity: '2026-04-18T10:00:00.000Z',
      sessionLastActivity: '2026-04-18T10:00:03.000Z',
      title: 'Export Test',
      workspaceDir: workDir,
      kimiCodeVersion: '1.0.0-test',
    });
    expect(result.manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const entries = readZipEntries(await readFile(outputPath));
    expect(entries.has('manifest.json')).toBe(true);
    expect(entries.get('state.json')?.toString('utf-8')).toContain(sid);
    expect(entries.get('subagents/a.txt')?.toString('utf-8')).toBe('child');
    expect([...entries.keys()].some((name) => name.includes(tmp))).toBe(false);

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as {
      sessionId: string;
      title: string;
      workspaceDir: string;
    };
    expect(manifest.sessionId).toBe(sid);
    expect(manifest.title).toBe('Export Test');
    expect(manifest.workspaceDir).toBe(workDir);
  });

  it('uses the default output path when outputPath is omitted', async () => {
    const tmp = await makeTempDir();
    const sid = 'session_default_output';
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}', 'utf-8');

    const result = await exportSessionDirectory({
      request: { sessionId: sid, version: '1.0.0-test' },
      summary: makeSummary({ id: sid, sessionDir, workDir: tmp }),
    });

    const expectedPath = resolve(`${sid}.zip`);
    expect(result.zipPath).toBe(expectedPath);
    expect(existsSync(result.zipPath)).toBe(true);
    await rm(expectedPath, { force: true });
  });

  it('omits global log manifest path when the global log cannot be bundled', async () => {
    const tmp = await makeTempDir();
    const homeDir = join(tmp, 'home');
    const sid = 'ses_unreadable_global_log';
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}', 'utf-8');
    await mkdir(resolveGlobalLogPath(homeDir), { recursive: true });

    const outputPath = join(tmp, 'unreadable-global.zip');
    const result = await exportSessionDirectory({
      request: { sessionId: sid, outputPath, includeGlobalLog: true, version: '1.0.0-test' },
      summary: makeSummary({ id: sid, sessionDir, workDir: tmp }),
      homeDir,
    });

    expect(result.manifest.globalLogPath).toBeUndefined();
    expect(result.entries).not.toContain('logs/global/kimi-code.log');
    const entries = readZipEntries(await readFile(outputPath));
    expect(entries.has('logs/global/kimi-code.log')).toBe(false);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as Record<
      string,
      unknown
    >;
    expect(manifest['globalLogPath']).toBeUndefined();
  });

  it('supports relative outputPath and creates parent directories', async () => {
    const tmp = await makeTempDir();
    const sid = 'ses_relative_output';
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}', 'utf-8');

    const outputPath = join(tmp, 'exports/out.zip');
    const result = await exportSessionDirectory({
      request: { sessionId: sid, outputPath, version: '1.0.0-test' },
      summary: makeSummary({ id: sid, sessionDir, workDir: tmp }),
    });

    expect(result.zipPath).toBe(outputPath);
    expect(existsSync(result.zipPath)).toBe(true);
  });

  it('exports sessions without wire.jsonl and omits activity fields', async () => {
    const tmp = await makeTempDir();
    const sid = 'ses_no_wire';
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}', 'utf-8');

    const result = await exportSessionDirectory({
      request: { sessionId: sid, version: '1.0.0-test' },
      summary: makeSummary({ id: sid, sessionDir, workDir: tmp }),
    });

    expect(result.manifest.sessionFirstActivity).toBeUndefined();
    expect(result.manifest.sessionLastActivity).toBeUndefined();
    await rm(resolve(`${sid}.zip`), { force: true });
  });

  it('rejects empty or missing session directories', async () => {
    const tmp = await makeTempDir();
    const sid = 'ses_empty';
    const sessionDir = join(tmp, 'sessions', sid);
    await mkdir(sessionDir, { recursive: true });

    await expect(
      exportSessionDirectory({
        request: { sessionId: sid, version: '1.0.0-test' },
        summary: makeSummary({ id: sid, sessionDir, workDir: tmp }),
      }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.export_not_found',
    } satisfies Partial<KimiError>);
  });
});

describe('KimiHarness.exportSession', () => {
  it('exports a created session through the public Harness API', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    const session = await harness.createSession({
      id: 'ses_harness_export',
      workDir,
    });
    const sessionDir = (await harness.listSessions({ workDir })).find(
      (item) => item.id === session.id,
    )!.sessionDir;
    await writeFile(join(sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await mkdir(join(sessionDir, 'subagents'), { recursive: true });
    await writeFile(join(sessionDir, 'subagents', 'demo.txt'), 'demo', 'utf-8');

    const outputPath = join(workDir, 'export.zip');
    const result = await harness.exportSession({ id: session.id, outputPath, version: '1.0.0-test' });

    expect(result.zipPath).toBe(outputPath);
    expect(result.entries).toContain('manifest.json');
    expect(result.entries).toContain('state.json');
    expect(result.entries).toContain('wire.jsonl');
    expect(result.entries).toContain('subagents/demo.txt');
    expect(result.manifest.sessionId).toBe(session.id);
    expect(records).toContainEqual({
      event: 'export',
      sessionId: session.id,
      properties: undefined,
    });
  });

  it('rejects missing session ids', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const missingExport = harness.exportSession({ id: 'ses_missing', version: '1.0.0-test' });
    await expect(missingExport).rejects.toBeInstanceOf(KimiError);
    await expect(missingExport).rejects.toMatchObject({
      code: 'session.not_found',
      details: { sessionId: 'ses_missing' },
    } satisfies Partial<KimiError>);
  });
});
