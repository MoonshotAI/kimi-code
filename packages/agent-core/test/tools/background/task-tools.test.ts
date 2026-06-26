/**
 * Covers: TaskListTool, TaskOutputTool, TaskStopTool.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundManager,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import { TaskListTool } from '../../../src/tools/background/task-list';
import { TaskOutputTool } from '../../../src/tools/background/task-output';
import { TaskStopTool } from '../../../src/tools/background/task-stop';
import {
  agentTask,
  createBackgroundManager,
  registerProcess,
  waitForOutput,
} from '../../agent/background/helpers';
import { executeTool } from '../fixtures/execute-tool';
import { toolContentString } from '../fixtures/fake-kaos';

const signal = new AbortController().signal;

function context<Input>(toolCallId: string, args: Input) {
  return { turnId: '0', toolCallId, args, signal };
}

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = 143;
    resolveWait(143);
  });
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function persistedProcess(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-deadbeef',
    kind: 'process',
    command: 'sleep 60',
    description: 'persisted task',
    pid: 999,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_001,
    exitCode: null,
    status: 'killed',
    ...overrides,
  };
}

async function taskOutput(manager: BackgroundManager, taskId: string, block = false): Promise<string> {
  const result = await executeTool(
    new TaskOutputTool(manager),
    context('task_output', { task_id: taskId, block, timeout: 1 }),
  );
  expect(result.isError).toBe(false);
  return toolContentString(result);
}

describe('TaskListTool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "TaskList"', () => {
    expect(new TaskListTool(createBackgroundManager().manager).name).toBe('TaskList');
  });

  it('returns "No background tasks found." when empty', async () => {
    const tool = new TaskListTool(createBackgroundManager().manager);

    const result = await executeTool(tool, context('c_empty', { active_only: true }));

    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('lists active process tasks', async () => {
    const { manager } = createBackgroundManager();
    registerProcess(manager, pendingProcess(), 'sleep 60', 'test task');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_active', { active_only: true }),
    );
    const content = toolContentString(result);

    expect(content).toMatch(/^active_background_tasks:\s*1/);
    expect(content).toContain('kind: process');
    expect(content).toContain('command: sleep 60');
    expect(content).toContain('description: test task');
  });

  it('excludes terminal tasks from active_only=true', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'done');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_active_terminal', { active_only: true }),
    );

    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('includes terminal tasks and exit_code when active_only=false', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(7), 'exit 7', 'exit code test');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_all_terminal', { active_only: false }),
    );
    const content = toolContentString(result);

    expect(content).toMatch(/^background_tasks:\s*1/);
    expect(content).toContain(taskId);
    expect(content).toContain('status: failed');
    expect(content).toContain('exit_code: 7');
  });

  it('honours the limit parameter', async () => {
    const { manager } = createBackgroundManager();
    const first = registerProcess(manager, pendingProcess(), 'sleep 1', 'one');
    const second = registerProcess(manager, pendingProcess(), 'sleep 2', 'two');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_limit', { active_only: true, limit: 1 }),
    );
    const content = toolContentString(result);

    expect(content).toContain('active_background_tasks: 1');
    expect(content).toContain(first);
    expect(content).not.toContain(second);
  });

  it('includes stop_reason for stopped tasks in all-tasks view', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop reason');
    await manager.stop(taskId, 'superseded by newer task');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_stop_reason', { active_only: false }),
    );

    expect(toolContentString(result)).toContain(
      'stop_reason: superseded by newer task',
    );
  });

  it('does not sleep when listing a running task', async () => {
    vi.useFakeTimers();
    const { manager } = createBackgroundManager();
    registerProcess(manager, pendingProcess(), 'sleep 60', 'running list');
    const resultPromise = executeTool(
      new TaskListTool(manager),
      context('c_latency', { active_only: true }),
    );

    await Promise.resolve();
    const result = await resultPromise;

    expect(toolContentString(result)).toContain('running list');
  });
});

describe('TaskOutputTool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "TaskOutput"', () => {
    expect(new TaskOutputTool(createBackgroundManager().manager).name).toBe('TaskOutput');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskOutputTool(createBackgroundManager().manager),
      context('c_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('returns live output when no persisted log is available', async () => {
    const { manager } = createBackgroundManager();
    const payload = 'DETACHED-PAYLOAD-LINE\n';
    const taskId = registerProcess(manager, immediateProcess(0, payload), 'echo demo', 'demo');

    await manager.wait(taskId);
    await waitForOutput(manager, taskId, 'DETACHED-PAYLOAD-LINE');
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('retrieval_status: success');
    expect(content).toContain('status: completed');
    expect(content).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(content).toContain(`output_size_bytes: ${Buffer.byteLength(payload).toString()}`);
    expect(content).not.toContain('output_path:');
  });

  it('returns persisted output path and guidance when a log is available', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-tool-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const taskId = registerProcess(
        manager,
        immediateProcess(0, 'STDOUT-PAYLOAD-LINE\n'),
        'echo demo',
        'output test',
      );

      await manager.wait(taskId);
      await waitForOutput(manager, taskId, 'STDOUT-PAYLOAD-LINE');
      const content = await taskOutput(manager, taskId, true);

      expect(content).toContain('status: completed');
      expect(content).toContain('output_path:');
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toContain('full_output_hint:');
      expect(content).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('returns agent metadata and final summary without process fields', async () => {
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'SUBAGENT-FINAL-SUMMARY\n' }),
        'agent output test',
        { agentId: 'agent-child', subagentType: 'coder' },
      ),
    );

    await manager.wait(taskId);
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('kind: agent');
    expect(content).toContain('agent_id: agent-child');
    expect(content).toContain('subagent_type: coder');
    expect(content).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(content).not.toMatch(/^pid:/m);
    expect(content).not.toMatch(/^command:/m);
    expect(content).not.toMatch(/^exit_code:/m);
  });

  it('reads persisted output for a task loaded after restart', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-'));
    try {
      const writer = createBackgroundManager({ sessionDir }).manager;
      const taskId = registerProcess(
        writer,
        immediateProcess(0, 'persisted output\n'),
        'echo persisted output',
        'persist output test',
      );
      await writer.wait(taskId);
      await waitForOutput(writer, taskId, 'persisted output');

      const reader = createBackgroundManager({ sessionDir }).manager;
      await reader.loadFromDisk();
      await reader.reconcile();
      const content = await taskOutput(reader, taskId);

      expect(content).toContain('status: completed');
      expect(content).toContain('output_path:');
      expect(content).toContain('persisted output');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('returns not_ready for non-blocking running tasks', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'running task');

    const content = await taskOutput(manager, taskId);

    expect(content).toContain('retrieval_status: not_ready');
    expect(content).toContain('status: running');
  });

  it('returns timeout for block=true when a running task does not finish', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'blocking task');

    const content = await taskOutput(manager, taskId, true);

    expect(content).toContain('retrieval_status: timeout');
    expect(content).toContain('status: running');
  });

  it('surfaces timeout terminal metadata', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'will time out'),
      { timeoutMs: 1 },
    );

    const terminal = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(5_010);
    await terminal;
    const content = await taskOutput(manager, taskId, true);

    expect(content).toContain('status: timed_out');
    expect(content).not.toContain('stop_reason:');
    expect(content).toContain('terminal_reason: timed_out');
  });

  it('surfaces stopped terminal metadata', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stoppable task');

    await manager.stop(taskId, 'operator cancelled');
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('status: killed');
    expect(content).toContain('stop_reason: operator cancelled');
    expect(content).toContain('terminal_reason: stopped');
  });

  it('does not advertise output_path when the persisted log file does not exist', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-empty-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

      await manager.wait(taskId);
      const content = await taskOutput(manager, taskId);

      expect(content).not.toContain('output_path:');
      expect(content).toContain('output_size_bytes: 0');
      expect(content).toContain('full_output_available: false');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('truncates output > 32 KiB to a tail preview and reports paging metadata', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-trunc-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const head = 'HEAD-MARKER\n';
      const tail = 'TAIL-MARKER\n';
      const big = head + 'x'.repeat(200 * 1024) + tail;
      const taskId = registerProcess(manager, immediateProcess(0, big), 'echo big', 'large');

      await manager.wait(taskId);
      const content = await taskOutput(manager, taskId);

      expect(content).toContain('output_truncated: true');
      expect(content).toContain(`output_size_bytes: ${Buffer.byteLength(big).toString()}`);
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toContain('[Truncated. Full output:');
      expect(content).toContain('TAIL-MARKER');
      expect(content).not.toContain('HEAD-MARKER');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('lookup of a non-existent task does not create persisted state', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-missing-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_missing', { task_id: 'bash-noex0000' }),
      );

      expect(result.isError).toBe(true);
      expect(await new BackgroundTaskPersistence(sessionDir).listTasks()).toEqual([]);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('TaskStopTool', () => {
  it('has name "TaskStop"', () => {
    expect(new TaskStopTool(createBackgroundManager().manager).name).toBe('TaskStop');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskStopTool(createBackgroundManager().manager),
      context('c_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('stops a running task and records the reason', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_stop', { task_id: taskId, reason: 'custom stop reason' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('status: killed');
    expect(toolContentString(result)).toContain('custom stop reason');
    expect(manager.getTask(taskId)?.stopReason).toBe('custom stop reason');
  });

  it('does not steer a terminal notification for model-requested stops', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_stop_silent', { task_id: taskId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('status: killed');
    expect(agent.turn.steer).not.toHaveBeenCalled();
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'killed',
      terminalNotificationSuppressed: true,
    });
  });

  it('persists stop reason when the manager has persistence', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-reason-'));
    try {
      const writer = createBackgroundManager({ sessionDir }).manager;
      const taskId = registerProcess(writer, pendingProcess(), 'sleep 60', 'persist stop');

      const result = await executeTool(
        new TaskStopTool(writer),
        context('c_stop_reason', { task_id: taskId, reason: 'operator cancelled' }),
      );
      expect(result.isError).toBe(false);

      const { agent, manager: reader } = createBackgroundManager({ sessionDir });
      await reader.loadFromDisk();
      expect(reader.getTask(taskId)).toMatchObject({
        stopReason: 'operator cancelled',
        terminalNotificationSuppressed: true,
      });
      await reader.reconcile();
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'empty reason test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_empty_reason', { task_id: taskId, reason }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('reason: Stopped by TaskStop');
    expect(manager.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  });

  it('returns info when task is already terminal', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'terminal test');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_terminal', { task_id: taskId }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result).trim().split('\n')).toEqual([
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(manager.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  });

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-blank-stored-reason-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ stopReason: '' }));
      const reader = createBackgroundManager({ sessionDir }).manager;
      await reader.loadFromDisk();

      const result = await executeTool(
        new TaskStopTool(reader),
        context('c_blank_stored', { task_id: 'bash-deadbeef' }),
      );

      expect(result.isError).toBe(false);
      expect(toolContentString(result).trim().split('\n')[2]).toBe(
        'reason: Task already in terminal state',
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('background tool descriptions', () => {
  const manager = createBackgroundManager().manager;

  it('TaskOutput description mentions background tasks, block, output_path, and Read', () => {
    const description = new TaskOutputTool(manager).description;

    expect(description).toMatch(/background/i);
    expect(description).toMatch(/block/);
    expect(description).toMatch(/output_path/);
    expect(description).toMatch(/Read/);
    // terminal_reason can also be `failed` (task-output.ts terminalReason), not
    // just timed_out / stopped — the description must enumerate it.
    expect(description).toContain('`failed`');
    // ...but a plain non-zero command exit carries no terminal_reason/stop_reason —
    // the description must point the model at exit_code for that common failure.
    expect(description).toContain('exit_code');
    // Backstop: don't let the model use TaskOutput to sit and wait for a result it needs.
    expect(description).toContain('run that task in the foreground instead');
  });

  it('TaskList description mentions active_only default, read-only, and plan-mode safety', () => {
    const description = new TaskListTool(manager).description;

    expect(description).toMatch(/active_only/);
    expect(description).toMatch(/read[- ]only/i);
    expect(description).toMatch(/plan[- ]mode/i);
    expect(description).toMatch(/background tasks?/i);
    // command/PID/exit-code are shell-task fields only (ProcessBackgroundTaskInfo).
    expect(description).toMatch(/shell tasks/i);
  });

  it('TaskStop description clarifies destructive cancellation and generic behavior', () => {
    const description = new TaskStopTool(manager).description;

    expect(description).toMatch(/destructive/i);
    expect(description).toMatch(/cancel/i);
    expect(description).toMatch(/general[-\s]?purpose|generic/i);
    expect(description).not.toMatch(/bash[- ]?only/i);
  });
});
