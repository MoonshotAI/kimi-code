import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { basename, dirname, join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester, LoopRecord } from '@moonshot-ai/agent-core/loop/index';
import {
  AGENT_LOG_PREFIX,
  SESSION_LOG,
  SessionSpaceError,
  type SessionEvent,
} from '@moonshot-ai/agent-core/session/index';
import {
  encodeCommit,
  parseLog,
  type Event,
  type Journal,
} from '@moonshot-ai/agent-core/store/index';

import {
  createSessionExport,
  readSessionLogs,
  scanSessionLogs,
  SessionExportError,
  SessionExportRef,
  type CreateSessionExportProps,
  type SessionExportFace,
} from '#/features/sessionExport/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  type Harness,
  type HarnessSessionSpace,
} from '#/runtime/index';

const SESSION_ID = 'ses_demo';

const tmps: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(tmps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-export-test-'));
  tmps.push(dir);
  return dir;
}

async function mountExport(
  space: HarnessSessionSpace,
  props?: Partial<CreateSessionExportProps>,
): Promise<() => SessionExportFace | undefined> {
  const harness = createHarness({ space });
  harnesses.push(harness);
  let face: Readonly<ShallowRef<SessionExportFace | undefined>> | undefined;
  const probe = createFeature('session-export-probe', {
    app: () => {
      face = useInject(SessionExportRef);
    },
  });
  await harness.app.features.add(
    createSessionExport({
      version: props?.version ?? '1.0.0-test',
      wireProtocolVersion: '1',
      globalLogPath: props?.globalLogPath,
      desktopLogPath: props?.desktopLogPath,
    }),
  );
  await harness.app.features.add(probe);
  return () => face?.value;
}

function commit<E extends Event>(seq: number, time: number, events: readonly E[]): string {
  return encodeCommit({ seq, time, events });
}

async function appendLog(journal: Journal, name: string, lines: readonly string[]): Promise<void> {
  for (const [seq, line] of lines.entries()) {
    await journal.append(name, seq, line);
  }
}

const started = (turnId: number): LoopRecord => ({ type: 'turn.started', turnId, trigger: 'normal' });
const ended = (turnId: number): LoopRecord => ({ type: 'turn.ended', turnId, outcome: { type: 'done' } });
const appended = (entry: HistoryMessage, turnId: number): LoopRecord => ({
  type: 'message.appended',
  turnId,
  step: 0,
  source: 'normal',
  entry,
});

function userEntry(text: string): HistoryMessage {
  return createUserEntry(createUserMessage(text));
}

function assistantEntry(text: string): HistoryMessage {
  return { message: createAssistantMessage([{ type: 'text', text }]) };
}

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      const messages = rest.content?.messages ?? [];
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      return { type: 'done', message: createAssistantMessage([{ type: 'text', text: `echo:${text}` }]) };
    },
  };
  return self;
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('sessionExport feature', () => {
  it('exports a live session journal with loop activity in the manifest', async () => {
    const tmp = await makeTmp();
    const space = memoryHarnessSpace();
    const face = await mountExport(space);
    const harness = harnesses.at(-1)!;
    const session = await harness.app.create({ sessionId: SESSION_ID, title: 'Demo' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, SESSION_ID, 'main', echoRequester());
    await agent.loop.runTurn(createUserEntry(createUserMessage('hello'), { source: 'input' }));
    await agent.flush();
    const outputPath = join(tmp, 'export.zip');

    const result = await face()!.export({ sessionId: SESSION_ID, outputPath });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.entries).toEqual(['manifest.json', 'agents/main.jsonl', 'session.jsonl']);
    expect(result.manifest).toMatchObject({
      sessionId: SESSION_ID,
      kimiCodeVersion: '1.0.0-test',
      wireProtocolVersion: '1',
      os: `${process.platform} ${process.arch}`,
      nodejsVersion: process.version.replace(/^v/, ''),
      title: 'Demo',
      sessionFirstActivity: expect.any(String),
      sessionLastActivity: expect.any(String),
    });

    const bytes = await readZipEntry(outputPath, 'agents/main.jsonl');
    const commits = parseLog<LoopRecord>(bytes.toString('utf8'));
    const texts = commits
      .flatMap((entry) => entry.events ?? [])
      .flatMap((event) =>
        event.type === 'message.appended' && event.entry.message.role === 'user'
          ? [extractText(event.entry.message)]
          : [],
      );
    expect(texts).toContain('hello');
    const roster = parseLog<SessionEvent>((await readZipEntry(outputPath, 'session.jsonl')).toString('utf8'));
    expect(
      roster.flatMap((entry) => entry.events ?? []).some((event) => event.type === 'agent.registered' && event.agentId === 'main'),
    ).toBe(true);

    const container = await space.open(SESSION_ID);
    const scan = scanSessionLogs(await readSessionLogs(container.journal));
    expect(scan.firstUserInput).toBe('hello');
    expect(scan.firstActivityMs).toBeDefined();
    expect(scan.lastUserMessageMs).toBeDefined();
    expect(scan.firstActivityMs!).toBeLessThanOrEqual(scan.lastUserMessageMs!);
    expect(scan.lastUserMessageMs!).toBeLessThanOrEqual(scan.lastActivityMs!);
  });

  it('scans fixed-time commits across the session and agent logs', async () => {
    const tmp = await makeTmp();
    const space = memoryHarnessSpace();
    const container = await space.create(SESSION_ID, { title: 'Demo' });
    await appendLog(container.journal, SESSION_LOG, [
      commit<SessionEvent>(0, 1_700_000_000_000, [{ type: 'agent.registered', agentId: 'main' }]),
    ]);
    await appendLog(container.journal, `${AGENT_LOG_PREFIX}main`, [
      commit<LoopRecord>(0, 1_700_000_001_000, [started(0)]),
      commit<LoopRecord>(1, 1_700_000_005_000, [appended(userEntry('hello'), 0)]),
      commit<LoopRecord>(2, 1_700_000_010_000, [appended(assistantEntry('hi'), 0)]),
      commit<LoopRecord>(3, 1_700_000_011_000, [ended(0)]),
    ]);
    await appendLog(container.journal, `${AGENT_LOG_PREFIX}sub`, [
      commit<LoopRecord>(0, 1_700_000_020_000, [appended(userEntry('later'), 0)]),
    ]);
    const face = await mountExport(space);
    const outputPath = join(tmp, 'export.zip');

    const result = await face()!.export({ sessionId: SESSION_ID, outputPath });

    expect(result.entries).toEqual([
      'manifest.json',
      'agents/main.jsonl',
      'agents/sub.jsonl',
      'session.jsonl',
    ]);
    expect(result.manifest).toMatchObject({
      sessionId: SESSION_ID,
      title: 'Demo',
      sessionFirstActivity: '2023-11-14T22:13:20.000Z',
      sessionLastActivity: '2023-11-14T22:13:40.000Z',
    });

    const reopened = await space.open(SESSION_ID);
    const logs = await readSessionLogs(reopened.journal);
    expect(scanSessionLogs(logs)).toEqual({
      firstActivityMs: 1_700_000_000_000,
      lastActivityMs: 1_700_000_020_000,
      lastUserMessageMs: 1_700_000_020_000,
      firstUserInput: 'hello',
    });
    const main = logs.find((log) => log.name === 'agents/main')!;
    await expect(readZipEntry(outputPath, 'agents/main.jsonl')).resolves.toEqual(
      Buffer.from(main.lines.map((line) => `${line}\n`).join(''), 'utf8'),
    );

    expect(
      scanSessionLogs([
        {
          name: 'agents/torn',
          lines: [
            'not json',
            commit<LoopRecord>(1, 5_000, [appended(userEntry('hey'), 0)]),
          ],
        },
      ]),
    ).toEqual({
      firstActivityMs: 5_000,
      lastActivityMs: 5_000,
      lastUserMessageMs: 5_000,
      firstUserInput: 'hey',
    });
  });

  it('uses a timestamped default output path and never overwrites an earlier export', async () => {
    const space = memoryHarnessSpace();
    const container = await space.create(SESSION_ID, { title: 'Demo' });
    await appendLog(container.journal, SESSION_LOG, [
      commit<SessionEvent>(0, 1, [{ type: 'agent.registered', agentId: 'main' }]),
    ]);
    const face = await mountExport(space);

    const first = await face()!.export({ sessionId: SESSION_ID });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100 - (Date.now() % 1000)));
    const second = await face()!.export({ sessionId: SESSION_ID });

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
    const face = await mountExport(memoryHarnessSpace());

    const error = await face()!.export({ sessionId: 'ses_missing' }).then(
      () => {
        throw new Error('export should have rejected');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SessionSpaceError);
    expect(error).toMatchObject({ reason: 'not-found' });
  });

  it('rejects with export_not_found when the session has no exportable journal', async () => {
    const space = memoryHarnessSpace();
    await space.create('ses_empty', { title: 'Empty' });
    const face = await mountExport(space);

    await expect(face()!.export({ sessionId: 'ses_empty' })).rejects.toMatchObject({
      name: 'SessionExportError',
      code: 'session.export_not_found',
    });
  });

  it('rejects an output path that conflicts with a selected source without modifying it', async () => {
    const tmp = await makeTmp();
    const space = memoryHarnessSpace();
    const container = await space.create(SESSION_ID, { title: 'Demo' });
    await appendLog(container.journal, SESSION_LOG, [
      commit<SessionEvent>(0, 1, [{ type: 'agent.registered', agentId: 'main' }]),
    ]);
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    await mkdir(dirname(globalLogPath), { recursive: true });
    const original = Buffer.from('{"msg":"global"}\n', 'utf8');
    await writeFile(globalLogPath, original);
    const face = await mountExport(space, { globalLogPath });

    await expect(
      face()!.export({ sessionId: SESSION_ID, outputPath: globalLogPath, includeGlobalLog: true }),
    ).rejects.toMatchObject({
      name: 'SessionExportError',
      code: 'session.export_output_conflict',
      details: { outputPath: globalLogPath, source: 'logs/global/kimi-code.log' },
    });
    await expect(readFile(globalLogPath)).resolves.toEqual(original);
  });

  it('bundles optional global, desktop and web logs and omits a missing global log', async () => {
    const tmp = await makeTmp();
    const space = memoryHarnessSpace();
    const container = await space.create(SESSION_ID, { title: 'Demo' });
    await appendLog(container.journal, SESSION_LOG, [
      commit<SessionEvent>(0, 1, [{ type: 'agent.registered', agentId: 'main' }]),
    ]);
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    const desktopLogPath = join(tmp, 'logs', 'kimi-code-desktop.log');
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(globalLogPath, '{"msg":"global"}\n', 'utf8');
    await writeFile(desktopLogPath, 'desktop log\n', 'utf8');
    const webLog = JSON.stringify({ event: 'websocket.connected', time: 1 });
    const face = await mountExport(space, { globalLogPath, desktopLogPath });

    const outputPath = join(tmp, 'with-logs.zip');
    const result = await face()!.export({
      sessionId: SESSION_ID,
      outputPath,
      includeGlobalLog: true,
      includeDesktopLog: true,
      webLog,
    });

    expect(result.entries).toEqual([
      'manifest.json',
      'session.jsonl',
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
    const missing = await face()!.export({
      sessionId: SESSION_ID,
      outputPath: join(tmp, 'missing-global.zip'),
      includeGlobalLog: true,
    });
    expect(missing.entries).not.toContain('logs/global/kimi-code.log');
    expect(missing.manifest.globalLogPath).toBeUndefined();
  });

  it('rejects when the signal is already aborted', async () => {
    const space = memoryHarnessSpace();
    const container = await space.create(SESSION_ID, { title: 'Demo' });
    await appendLog(container.journal, SESSION_LOG, [
      commit<SessionEvent>(0, 1, [{ type: 'agent.registered', agentId: 'main' }]),
    ]);
    const face = await mountExport(space);
    const abort = new AbortController();
    abort.abort();

    await expect(
      face()!.export({ sessionId: SESSION_ID, signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws a coded error at creation when the host version is blank', () => {
    let caught: unknown;
    try {
      createSessionExport({ version: ' ' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionExportError);
    expect(caught).toMatchObject({
      code: 'session.export_missing_version',
      message: 'Session export requires a host version.',
    });
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
