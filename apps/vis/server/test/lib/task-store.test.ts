import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import {
  isSafeTaskId,
  listBackgroundTasks,
  readTaskOutput,
  taskOutputMetadata,
  taskOutputSizeBytes,
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

    await writeTask(sessionDir, 'bash-aaaaaaaa.json', {
      taskId: 'bash-aaaaaaaa', kind: 'process', description: 'run build',
      command: 'pnpm build', pid: 4242, exitCode: 0, status: 'completed',
      detached: true, startedAt: 1000, endedAt: 2000, stopReason: 'finished',
      terminalNotificationSuppressed: true, resumeReminded: false, timeoutMs: 60_000,
      parentToolCallId: 'tool-process',
    });
    await writeTask(sessionDir, 'agent-bbbbbbbb.json', {
      taskId: 'agent-bbbbbbbb', kind: 'agent', description: 'explore repo',
      agentId: 'agent-1', subagentType: 'Explore', status: 'running',
      detached: true, startedAt: 3000, endedAt: null,
      parentToolCallId: 'tool-agent', model: 'kimi-for-coding',
      thinkingEffort: 'high', stopCode: 'end_turn',
    });
    await writeTask(sessionDir, 'question-cccccccc.json', {
      taskId: 'question-cccccccc', kind: 'question', description: 'ask user',
      questionCount: 2, status: 'running', detached: false,
      startedAt: 2500, endedAt: null, toolCallId: 'tool-question',
    });

    const tasks = await listBackgroundTasks(sessionDir);
    expect(tasks.map((t) => t.taskId)).toEqual([
      'agent-bbbbbbbb', // startedAt 3000
      'question-cccccccc', // 2500
      'bash-aaaaaaaa', // 1000
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
      parentToolCallId: 'tool-process',
    });
    const agent = tasks.find((t) => t.kind === 'agent');
    expect(agent).toMatchObject({
      agentId: 'agent-1',
      subagentType: 'Explore',
      parentToolCallId: 'tool-agent',
      model: 'kimi-for-coding',
      thinkingEffort: 'high',
      stopCode: 'end_turn',
    });
    const question = tasks.find((t) => t.kind === 'question');
    expect(question).toMatchObject({
      questionCount: 2,
      toolCallId: 'tool-question',
      detached: false,
    });
  });

  it('sanitizes type-corrupt optional fields on every current task kind', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    await writeTask(sessionDir, 'bash-aaaaaaaa.json', {
      taskId: 'bash-aaaaaaaa', kind: 'process', description: 'process',
      command: 'true', pid: 1, exitCode: null, status: 'running',
      detached: {}, startedAt: 100, endedAt: null, stopReason: {},
      terminalNotificationSuppressed: 'yes', resumeReminded: [], timeoutMs: '1000',
      parentToolCallId: {},
    });
    await writeTask(sessionDir, 'agent-bbbbbbbb.json', {
      taskId: 'agent-bbbbbbbb', kind: 'agent', description: 'agent',
      status: 'failed', startedAt: 200, endedAt: 300,
      agentId: {}, subagentType: [], parentToolCallId: 1, model: {},
      thinkingEffort: false, stopCode: { code: 'broken' },
    });
    await writeTask(sessionDir, 'question-cccccccc.json', {
      taskId: 'question-cccccccc', kind: 'question', description: 'question',
      questionCount: 2, status: 'completed', startedAt: 300, endedAt: 400,
      toolCallId: {},
    });

    const tasks = await listBackgroundTasks(sessionDir);
    expect(tasks).toHaveLength(3);

    const proc = tasks.find((task) => task.kind === 'process')!;
    expect(proc.detached).toBe(true);
    expect(proc.stopReason).toBeUndefined();
    expect(proc.terminalNotificationSuppressed).toBeUndefined();
    expect(proc.resumeReminded).toBeUndefined();
    expect(proc.timeoutMs).toBeUndefined();
    expect(proc.parentToolCallId).toBeUndefined();

    const agent = tasks.find((task) => task.kind === 'agent')!;
    expect(agent.agentId).toBeUndefined();
    expect(agent.subagentType).toBeUndefined();
    expect(agent.parentToolCallId).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.thinkingEffort).toBeUndefined();
    expect(agent.stopCode).toBeUndefined();

    const question = tasks.find((task) => task.kind === 'question')!;
    expect(question.toolCallId).toBeUndefined();
    for (const task of tasks) {
      expect(Object.values(task).some((value) => value !== null && typeof value === 'object'))
        .toBe(false);
    }
  });

  it('skips current tasks with invalid discriminants or required fields', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    const agent = {
      taskId: 'agent-00000000', kind: 'agent', description: 'valid',
      status: 'running', startedAt: 100, endedAt: null,
    };
    const corrupt = [
      { ...agent, taskId: 'invalid' },
      { ...agent, kind: 'unknown' },
      { ...agent, description: {} },
      { ...agent, status: 'awaiting_approval' },
      { ...agent, startedAt: '100' },
      { ...agent, endedAt: {} },
      { ...agent, kind: 'process', command: {}, pid: 1, exitCode: null },
      { ...agent, kind: 'process', command: 'true', pid: '1', exitCode: null },
      { ...agent, kind: 'process', command: 'true', pid: 1, exitCode: '0' },
      { ...agent, kind: 'question', questionCount: '1' },
    ];
    for (const [index, task] of corrupt.entries()) {
      await writeTask(sessionDir, `task-0000000${index}.json`, task);
    }
    await writeTask(sessionDir, 'agent-ffffffff.json', {
      ...agent,
      taskId: 'agent-ffffffff',
    });

    expect((await listBackgroundTasks(sessionDir)).map((task) => task.taskId)).toEqual([
      'agent-ffffffff',
    ]);
  });

  it('skips task ids that disagree with their file key and keeps primary shadowing', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const mainDir = join(sessionDir, 'agents', 'main');

    await writeTask(mainDir, 'bash-aaaaaaaa.json', {
      taskId: 'bash-bbbbbbbb', kind: 'process', description: 'current mismatch',
      command: 'true', pid: 1, exitCode: 0, status: 'completed',
      startedAt: 100, endedAt: 200,
    });
    await writeTask(mainDir, 'agent-cccccccc.json', {
      task_id: 'agent-dddddddd', command: '', description: 'legacy mismatch',
      pid: 1, started_at: 100, ended_at: 200, exit_code: 0, status: 'completed',
    });
    await writeTask(sessionDir, 'bash-eeeeeeee.json', {
      taskId: 'bash-eeeeeeee', kind: 'process', description: 'fallback shadowed',
      command: 'true', pid: 2, exitCode: 0, status: 'completed',
      startedAt: 100, endedAt: 200,
    });
    await writeTask(mainDir, 'bash-eeeeeeee.json', {
      taskId: 'bash-ffffffff', kind: 'process', description: 'primary mismatch',
      command: 'true', pid: 3, exitCode: 0, status: 'completed',
      startedAt: 100, endedAt: 200,
    });

    expect(await listBackgroundTasks(mainDir, sessionDir)).toEqual([]);
  });

  it('normalizes legacy snake_case tasks to the current shape', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    await writeTask(sessionDir, 'bash-dddddddd.json', {
      task_id: 'bash-dddddddd', command: 'sleep 1', description: 'legacy proc',
      pid: 9, started_at: 100, ended_at: 200, exit_code: null,
      status: 'failed', timed_out: true, timeout_ms: 5000,
    });
    await writeTask(sessionDir, 'agent-eeeeeeee.json', {
      task_id: 'agent-eeeeeeee', command: '', description: 'legacy agent',
      pid: 0, started_at: 50, ended_at: null, exit_code: null,
      status: 'awaiting_approval', agent_id: 'agent-2', subagent_type: 'general',
    });

    const tasks = await listBackgroundTasks(sessionDir);
    const proc = tasks.find((t) => t.taskId === 'bash-dddddddd')!;
    expect(proc.kind).toBe('process');
    expect(proc.status).toBe('timed_out'); // failed + timed_out → timed_out
    expect(proc).toMatchObject({ detached: true, timeoutMs: 5000 });
    const agent = tasks.find((t) => t.taskId === 'agent-eeeeeeee')!;
    expect(agent.kind).toBe('agent');
    expect(agent.status).toBe('running'); // awaiting_approval → running
    expect(agent).toMatchObject({ agentId: 'agent-2', subagentType: 'general' });
  });

  it('skips bad filenames, corrupt json, and unrecognized records', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeTask(sessionDir, 'not-a-valid-id.json', { taskId: 'x', kind: 'process' });
    await mkdir(join(sessionDir, 'tasks'), { recursive: true });
    await writeFile(join(sessionDir, 'tasks', 'bash-ffffffff.json'), '{ broken');
    await writeTask(sessionDir, 'bash-99999999.json', { unrelated: true });
    expect(await listBackgroundTasks(sessionDir)).toEqual([]);
  });

  it('tolerates type-corrupt legacy fields instead of failing the whole listing', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeTask(sessionDir, 'bash-aaaaaaaa.json', {
      taskId: 'bash-aaaaaaaa', kind: 'process', description: 'ok', command: 'x',
      pid: 1, exitCode: 0, status: 'completed', detached: true, startedAt: 100, endedAt: 200,
    });
    // Passes the shape guard (has task_id) but stop_reason / subagent_type are
    // numbers — the old code threw on `.trim()` and lost ALL tasks.
    await writeTask(sessionDir, 'agent-bbbbbbbb.json', {
      task_id: 'agent-bbbbbbbb', command: '', description: 'bad', pid: 0,
      started_at: 50, ended_at: null, exit_code: null, status: 'failed',
      stop_reason: 5, subagent_type: 5,
    });

    const tasks = await listBackgroundTasks(sessionDir);
    // No throw; both tasks listed, the corrupt fields coerced away.
    expect(tasks.map((t) => t.taskId).toSorted()).toEqual(['agent-bbbbbbbb', 'bash-aaaaaaaa']);
    const bad = tasks.find((t) => t.taskId === 'agent-bbbbbbbb')!;
    expect(bad.stopReason).toBeUndefined();
    expect(bad.kind === 'agent' ? bad.subagentType : 'n/a').toBeUndefined();
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

    await writeTask(sessionDir, 'bash-aaaaaaaa.json', {
      taskId: 'bash-aaaaaaaa', kind: 'process', description: 'fallback shadowed',
      command: 'fallback', pid: 1, exitCode: 0, status: 'completed',
      detached: true, startedAt: 100, endedAt: 200,
    });
    await writeTask(sessionDir, 'bash-bbbbbbbb.json', {
      taskId: 'bash-bbbbbbbb', kind: 'process', description: 'fallback visible',
      command: 'fallback', pid: 2, exitCode: 0, status: 'completed',
      detached: true, startedAt: 200, endedAt: 300,
    });
    await mkdir(join(mainDir, 'tasks'), { recursive: true });
    await writeFile(join(mainDir, 'tasks', 'bash-aaaaaaaa.json'), '{ broken');
    await writeTask(mainDir, 'bash-cccccccc.json', {
      taskId: 'bash-cccccccc', kind: 'process', description: 'primary visible',
      command: 'primary', pid: 3, exitCode: 0, status: 'completed',
      detached: true, startedAt: 300, endedAt: 400,
    });

    const tasks = await listBackgroundTasks(mainDir, sessionDir);
    expect(tasks.map((task) => task.taskId)).toEqual(['bash-cccccccc', 'bash-bbbbbbbb']);
  });

  it('reads output.log byte windows with size + eof', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const dir = join(sessionDir, 'tasks', 'bash-12345678');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'output.log'), 'hello world');

    expect(await taskOutputSizeBytes(sessionDir, 'bash-12345678')).toBe(11);

    const head = await readTaskOutput(sessionDir, 'bash-12345678', 0, 5);
    expect(head).toMatchObject({ offset: 0, nextOffset: 5, size: 11, content: 'hello', eof: false });

    // Paging forward from the previous window's nextOffset reaches EOF exactly.
    const tail = await readTaskOutput(sessionDir, 'bash-12345678', head.nextOffset, 100);
    expect(tail).toMatchObject({ offset: 5, nextOffset: 11, size: 11, content: ' world', eof: true });

    const past = await readTaskOutput(sessionDir, 'bash-12345678', 50, 10);
    expect(past).toMatchObject({ content: '', eof: true });
  });

  it('returns an empty window when the log is absent', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const w = await readTaskOutput(sessionDir, 'bash-00000000', 0, 100);
    expect(w).toMatchObject({ size: 0, content: '', eof: true });
  });

  it('falls back to session-root output and treats an empty primary log as present', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const mainDir = join(sessionDir, 'agents', 'main');
    const fallbackOutputDir = join(sessionDir, 'tasks', 'bash-12345678');
    await mkdir(fallbackOutputDir, { recursive: true });
    await writeFile(join(fallbackOutputDir, 'output.log'), 'legacy output');

    expect(await taskOutputMetadata(mainDir, 'bash-12345678', sessionDir)).toEqual({
      exists: true,
      size: 13,
    });
    expect(await readTaskOutput(mainDir, 'bash-12345678', 0, 100, sessionDir)).toMatchObject({
      size: 13,
      content: 'legacy output',
      eof: true,
    });

    const primaryOutputDir = join(mainDir, 'tasks', 'bash-12345678');
    await mkdir(primaryOutputDir, { recursive: true });
    await writeFile(join(primaryOutputDir, 'output.log'), '');

    expect(await taskOutputMetadata(mainDir, 'bash-12345678', sessionDir)).toEqual({
      exists: true,
      size: 0,
    });
    expect(await readTaskOutput(mainDir, 'bash-12345678', 0, 100, sessionDir)).toMatchObject({
      size: 0,
      content: '',
      eof: true,
    });
  });

  it('isSafeTaskId guards traversal', () => {
    expect(isSafeTaskId('bash-1a2b3c4d')).toBe(true);
    expect(isSafeTaskId('agent-deadbeef')).toBe(true);
    expect(isSafeTaskId('../escape')).toBe(false);
    expect(isSafeTaskId('bash')).toBe(false);
    expect(isSafeTaskId('bg_abcd')).toBe(false);
  });
});
