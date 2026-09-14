import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import {
  listBackgroundTasks,
  readTaskOutput,
  taskOutputMetadata,
  taskOutputSizeBytes,
  taskStorageKey,
} from '../../src/lib/task-store';

async function writeTask(sessionDir: string, fileName: string, body: unknown): Promise<void> {
  const dir = join(sessionDir, 'tasks');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), JSON.stringify(body));
}

describe('task-store', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('lists current-shape tasks of every kind, normalized and newest-first', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    await writeTask(sessionDir, 'call_process.json', {
      taskId: 'call_process', kind: 'process', description: 'run build',
      command: 'pnpm build', pid: 4242, exitCode: 0, status: 'completed',
      detached: true, startedAt: 1000, endedAt: 2000, stopReason: 'finished',
      terminalNotificationSuppressed: true, resumeReminded: false, timeoutMs: 60_000,
    });
    await writeTask(sessionDir, 'call_agent.json', {
      taskId: 'call_agent', kind: 'agent', description: 'explore repo',
      agentId: 'agent-1', subagentType: 'Explore', status: 'running',
      detached: true, startedAt: 3000, endedAt: null,
      model: 'kimi-for-coding', thinkingEffort: 'high', stopCode: 'end_turn',
    });
    await writeTask(sessionDir, 'call_question.json', {
      taskId: 'call_question', kind: 'question', description: 'ask user',
      questionCount: 2, status: 'running', detached: false,
      startedAt: 2500, endedAt: null,
    });

    const tasks = await listBackgroundTasks(sessionDir);
    expect(tasks.map((t) => t.taskId)).toEqual([
      'call_agent', // startedAt 3000
      'call_question', // 2500
      'call_process', // 1000
    ]);
    const proc = tasks.find((t) => t.kind === 'process');
    expect(proc).toMatchObject({
      command: 'pnpm build',
      pid: 4242,
      exitCode: 0,
      stopReason: 'finished',
      terminalNotificationSuppressed: true,
      resumeReminded: false,
      timeoutMs: 60_000,
    });
    const agent = tasks.find((t) => t.kind === 'agent');
    expect(agent).toMatchObject({
      agentId: 'agent-1',
      subagentType: 'Explore',
      model: 'kimi-for-coding',
      thinkingEffort: 'high',
      stopCode: 'end_turn',
    });
    const question = tasks.find((t) => t.kind === 'question');
    expect(question).toMatchObject({
      questionCount: 2,
      taskId: 'call_question',
      detached: false,
    });
  });

  it('defaults a missing detached flag to true, mirroring the engine', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    await writeTask(sessionDir, 'call_agent.json', {
      taskId: 'call_agent', kind: 'agent', description: 'agent',
      status: 'failed', startedAt: 200, endedAt: 300,
    });

    const tasks = await listBackgroundTasks(sessionDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.detached).toBe(true);
  });

  it('keeps records whose embedded id disagrees with the file key and lets primary keys shadow fallback', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const mainDir = join(sessionDir, 'agents', 'main');

    await writeTask(mainDir, 'call_mismatch.json', {
      taskId: 'call_other', kind: 'process', description: 'current mismatch',
      command: 'true', pid: 1, exitCode: 0, status: 'completed',
      startedAt: 100, endedAt: 200,
    });
    await writeTask(sessionDir, 'call_shadowed.json', {
      taskId: 'call_shadowed', kind: 'process', description: 'fallback shadowed',
      command: 'true', pid: 2, exitCode: 0, status: 'completed',
      startedAt: 100, endedAt: 200,
    });
    await mkdir(join(mainDir, 'tasks'), { recursive: true });
    await writeFile(join(mainDir, 'tasks', 'call_shadowed.json'), '{ broken');

    const tasks = await listBackgroundTasks(mainDir, sessionDir);
    expect(tasks.map((t) => t.taskId)).toEqual(['call_other']);
  });

  it('treats filenames as storage keys and skips corrupt or unrecognized records', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeTask(sessionDir, 'enc~%42ash%3A21.json', { taskId: 'Bash:21', kind: 'process' });
    await writeTask(sessionDir, 'call_valid.json', { toolCallId: 'x', kind: 'process' });
    await mkdir(join(sessionDir, 'tasks'), { recursive: true });
    await writeFile(join(sessionDir, 'tasks', 'call_broken.json'), '{ broken');
    expect((await listBackgroundTasks(sessionDir)).map((t) => t.taskId)).toEqual(['Bash:21']);
  });

  it('returns [] when there is no tasks directory', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    expect(await listBackgroundTasks(sessionDir)).toEqual([]);
  });

  it('falls back to session-root tasks for main and lets primary keys shadow fallback', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const mainDir = join(sessionDir, 'agents', 'main');

    await writeTask(sessionDir, 'call_shadowed.json', {
      taskId: 'call_shadowed', kind: 'process', description: 'fallback shadowed',
      command: 'fallback', pid: 1, exitCode: 0, status: 'completed',
      detached: true, startedAt: 100, endedAt: 200,
    });
    await writeTask(sessionDir, 'call_fallback.json', {
      taskId: 'call_fallback', kind: 'process', description: 'fallback visible',
      command: 'fallback', pid: 2, exitCode: 0, status: 'completed',
      detached: true, startedAt: 200, endedAt: 300,
    });
    await mkdir(join(mainDir, 'tasks'), { recursive: true });
    await writeFile(join(mainDir, 'tasks', 'call_shadowed.json'), '{ broken');
    await writeTask(mainDir, 'call_primary.json', {
      taskId: 'call_primary', kind: 'process', description: 'primary visible',
      command: 'primary', pid: 3, exitCode: 0, status: 'completed',
      detached: true, startedAt: 300, endedAt: 400,
    });

    const tasks = await listBackgroundTasks(mainDir, sessionDir);
    expect(tasks.map((task) => task.taskId)).toEqual(['call_primary', 'call_fallback']);
  });

  it('reads output.log byte windows with size + eof', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const dir = join(sessionDir, 'tasks', 'call_abc123');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'output.log'), 'hello world');

    expect(await taskOutputSizeBytes(sessionDir, 'call_abc123')).toBe(11);

    const head = await readTaskOutput(sessionDir, 'call_abc123', 0, 5);
    expect(head).toMatchObject({ offset: 0, nextOffset: 5, size: 11, content: 'hello', eof: false });

    // Paging forward from the previous window's nextOffset reaches EOF exactly.
    const tail = await readTaskOutput(sessionDir, 'call_abc123', head.nextOffset, 100);
    expect(tail).toMatchObject({ offset: 5, nextOffset: 11, size: 11, content: ' world', eof: true });

    const past = await readTaskOutput(sessionDir, 'call_abc123', 50, 10);
    expect(past).toMatchObject({ content: '', eof: true });
  });

  it('returns an empty window when the log is absent', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const w = await readTaskOutput(sessionDir, 'call_missing', 0, 100);
    expect(w).toMatchObject({ size: 0, content: '', eof: true });
  });

  it('falls back to session-root output and treats an empty primary log as present', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const mainDir = join(sessionDir, 'agents', 'main');
    const fallbackOutputDir = join(sessionDir, 'tasks', 'call_abc123');
    await mkdir(fallbackOutputDir, { recursive: true });
    await writeFile(join(fallbackOutputDir, 'output.log'), 'legacy output');

    expect(await taskOutputMetadata(mainDir, 'call_abc123', sessionDir)).toEqual({
      exists: true,
      size: 13,
    });
    expect(await readTaskOutput(mainDir, 'call_abc123', 0, 100, sessionDir)).toMatchObject({
      size: 13,
      content: 'legacy output',
      eof: true,
    });

    const primaryOutputDir = join(mainDir, 'tasks', 'call_abc123');
    await mkdir(primaryOutputDir, { recursive: true });
    await writeFile(join(primaryOutputDir, 'output.log'), '');

    expect(await taskOutputMetadata(mainDir, 'call_abc123', sessionDir)).toEqual({
      exists: true,
      size: 0,
    });
    expect(await readTaskOutput(mainDir, 'call_abc123', 0, 100, sessionDir)).toMatchObject({
      size: 0,
      content: '',
      eof: true,
    });
  });

  it('taskStorageKey derives bounded portable keys for path-unsafe ids', () => {
    expect(taskStorageKey('call_abc123')).toBe('call_abc123');
    expect(taskStorageKey('bash-1a2b3c4d')).toBe('bash-1a2b3c4d');
    expect(taskStorageKey('Bash:21')).toBe('enc~%42ash%3A21');
    expect(taskStorageKey('bash:21')).toBe('enc~bash%3A21');
    expect(taskStorageKey('../escape')).toBe('enc~%2E%2E%2Fescape');
    expect(taskStorageKey('a\\b')).toBe('enc~a%5Cb');
    expect(taskStorageKey('CON')).toBe('enc~%43%4F%4E');
    expect(taskStorageKey('任务')).toBe('enc~%u4EFB%u52A1');
    expect(taskStorageKey('\uD800')).toBe('enc~%uD800');
    expect(taskStorageKey('\uDC00')).toBe('enc~%uDC00');
    expect(taskStorageKey('\uFFFD')).toBe('enc~%uFFFD');
    const longId = 'x'.repeat(100);
    const key = taskStorageKey(longId);
    expect(key).toMatch(/^enc~x{40}~[0-9a-f]{16}$/);
    expect(taskStorageKey(longId)).toBe(key);
  });
});
