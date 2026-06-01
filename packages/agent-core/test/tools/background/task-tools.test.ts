/**
 * Covers: TaskListTool, TaskOutputTool, TaskStopTool.
 *
 * Uses KaosProcess fakes.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';
import { writeTask } from '../../../src/tools/background/persist';
import { BACKGROUND_TASK_TIMEOUT_STOP_REASON } from '../../../src/tools/background/task';
import { TaskListTool } from '../../../src/tools/background/task-list';
import { TaskOutputTool } from '../../../src/tools/background/task-output';
import { TaskStopTool } from '../../../src/tools/background/task-stop';
import { toolContentString } from '../fixtures/fake-kaos';
import { executeTool } from '../fixtures/execute-tool';

const signal = new AbortController().signal;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode === null) {
      currentExitCode = 143;
      resolveWait(143);
    }
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
  };
}

function processExitingAfterTimer(exitCode = 143, delayMs = 5): KaosProcess {
  let currentExitCode: number | null = null;
  const waitPromise = new Promise<number>((resolve) => {
    setTimeout(() => {
      currentExitCode = exitCode;
      resolve(exitCode);
    }, delayMs);
  });
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54322,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

async function waitForPersistedOutput(
  manager: BackgroundProcessManager,
  taskId: string,
  expectedOutput: string,
) {
  const tool = new TaskOutputTool(manager);
  let lastContent = '';
  for (let i = 0; i < 20; i++) {
    await manager.loadFromDisk();
    const result = await executeTool(tool, context('c_persisted', { task_id: taskId }));
    lastContent = toolContentString(result);
    if (
      result.isError === false &&
      lastContent.includes('status: completed') &&
      lastContent.includes(expectedOutput)
    ) {
      return { result, content: lastContent };
    }
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
  throw new Error(`Task ${taskId} did not persist expected output. Last output:\n${lastContent}`);
}

async function waitForLiveOutput(
  manager: BackgroundProcessManager,
  taskId: string,
  expectedOutput: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (manager.getOutput(taskId).includes(expectedOutput)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`Task ${taskId} did not capture expected live output: ${expectedOutput}`);
}

describe('TaskListTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskListTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskList"', () => {
    expect(tool.name).toBe('TaskList');
  });

  it('returns "No background tasks found." when empty', async () => {
    const result = await executeTool(tool, context('c1', { active_only: true }));
    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('lists active tasks', () => {
    const proc = pendingProcess();
    manager.register(proc, 'sleep 60', 'test task');
    // Synchronous check — the task is running immediately after register.
    const tasks = manager.list(true);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.kind).toBe('process');
    if (tasks[0]!.kind !== 'process') throw new Error('expected process task');
    expect(tasks[0]!.command).toBe('sleep 60');
  });

  it('does not sleep when listing a normally running task', async () => {
    vi.useFakeTimers();
    try {
      const proc = pendingProcess();
      manager.register(proc, 'sleep 60', 'running list latency test');

      let settled = false;
      const resultPromise = executeTool(tool, context('c_running_list_latency', { active_only: true }));
      void resultPromise.then(() => {
        settled = true;
      });

      await flushMicrotasks();

      expect(settled).toBe(true);
      const result = await resultPromise;
      expect(toolContentString(result)).toContain('sleep 60');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not list an already-exited process as active', async () => {
    const proc = processExitingAfterTimer(143, 0);
    manager.register(proc, 'sleep 60', 'external kill list test');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const result = await executeTool(tool, context('c_just_exited_list', { active_only: true }));

    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('includes a task-count header in the output body', async () => {
    const proc = pendingProcess();
    manager.register(proc, 'sleep 60', 'header test');
    const result = await executeTool(tool, context('c_header', { active_only: true }));
    expect(toolContentString(result)).toMatch(/^active_background_tasks:\s*1/);
  });

  it('reports a zero task count when no tasks exist', async () => {
    const result = await executeTool(tool, context('c_header_empty', { active_only: true }));
    expect(toolContentString(result)).toMatch(/^active_background_tasks:\s*0/);
  });

  it('labels the header background_tasks (not active) when active_only=false', async () => {
    const proc = immediateProcess(0);
    manager.register(proc, 'echo done', 'header label test');
    await flushMicrotasks();
    const result = await executeTool(tool, context('c_header_all', { active_only: false }));
    const content = toolContentString(result);
    // A terminal task is not "active"; the all-tasks view must use a neutral label.
    expect(content).toMatch(/^background_tasks:\s*1/);
    expect(content).not.toContain('active_background_tasks');
  });

  it('includes exit_code for terminal tasks', async () => {
    const proc = immediateProcess(7);
    manager.register(proc, 'exit 7', 'exit code test');
    await flushMicrotasks();
    const result = await executeTool(tool, context('c_exit_code', { active_only: false }));
    const content = toolContentString(result);
    expect(content).toContain('exit_code: 7');
  });

  it('includes the stop reason for tasks ended by TaskStop', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'stop reason test');
    await manager.stop(taskId, 'superseded by newer task');
    const result = await executeTool(tool, context('c_stop_reason', { active_only: false }));
    const content = toolContentString(result);
    expect(content).toContain('stop_reason: superseded by newer task');
  });

  it('omits exit_code and reason for non-terminal tasks', async () => {
    const proc = pendingProcess();
    manager.register(proc, 'sleep 60', 'non-terminal test');
    const result = await executeTool(tool, context('c_non_terminal', { active_only: true }));
    const content = toolContentString(result);
    expect(content).not.toContain('exit_code:');
    expect(content).not.toContain('reason:');
  });

  describe('description', () => {
    it('explains the core purpose of enumerating background tasks', () => {
      expect(tool.description).toContain('background tasks');
      expect(tool.description.length).toBeGreaterThan(120);
    });

    it('documents the limit parameter bounds and default', () => {
      expect(tool.description).toContain('limit');
      expect(tool.description).toContain('20');
      expect(tool.description).toMatch(/1\s*(to|-|–|and)\s*100|between 1 and 100/i);
    });

    it('warns that active_only=false may include lost tasks from a prior process', () => {
      expect(tool.description).toMatch(/lost/i);
    });

    it('includes a Guidelines section', () => {
      expect(tool.description).toContain('Guidelines:');
    });

    it('guides re-enumerating tasks after compaction or when task IDs are lost', () => {
      expect(tool.description).toMatch(/compaction/i);
      expect(tool.description).toMatch(/re-?enumerate|re-?discover/i);
    });

    it('recommends keeping the default active_only=true', () => {
      expect(tool.description).toContain('active_only');
      expect(tool.description).toContain('true');
    });

    it('directs locating a task ID here before using TaskOutput for detail', () => {
      expect(tool.description).toContain('TaskOutput');
    });

    it('states the tool is read-only and safe in plan mode', () => {
      expect(tool.description).toMatch(/read-only/i);
      expect(tool.description).toMatch(/plan mode/i);
    });
  });
});

describe('TaskOutputTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskOutputTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskOutput"', () => {
    expect(tool.name).toBe('TaskOutput');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(tool, context('c1', { task_id: 'bash-unknown0' }));
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('returns output for a completed task', async () => {
    // TaskOutput reads output exclusively from the on-disk log, so this
    // test runs with a session directory attached — matching production,
    // where the manager is always constructed with one. A self-contained
    // manager + a terminal task keep teardown free of the cleanup race
    // that non-terminal tasks (still flushing persistence) would cause.
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-tool-'));
    const ownManager = new BackgroundProcessManager();
    ownManager.attachSessionDir(sessionDir);
    try {
      const taskId = ownManager.register(
        immediateProcess(0, 'STDOUT-PAYLOAD-LINE\n'),
        'echo demo',
        'output test',
      );
      await expect(ownManager.wait(taskId, 5_000)).resolves.toMatchObject({
        status: 'completed',
      });

      const result = await executeTool(new TaskOutputTool(ownManager),
        context('c2', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);
      expect(content).toContain('status: completed');
      // Assert on a payload marker that does NOT collide with the command
      // or description, so this genuinely verifies output retrieval rather
      // than matching an echoed metadata field.
      expect(content).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
    } finally {
      ownManager._reset();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('returns live output when no persisted log is available', async () => {
    const taskId = manager.register(
      immediateProcess(0, 'DETACHED-PAYLOAD-LINE\n'),
      'echo demo',
      'detached output test',
    );
    await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({
      status: 'completed',
    });
    await waitForLiveOutput(manager, taskId, 'DETACHED-PAYLOAD-LINE');

    const result = await executeTool(tool, context('c_detached_output', { task_id: taskId }));

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('status: completed');
    expect(content).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(content).toContain(
      `output_size_bytes: ${String(Buffer.byteLength('DETACHED-PAYLOAD-LINE\n'))}`,
    );
    expect(content).not.toContain('output_path:');
  });

  it('returns agent metadata and final summary without process fields', async () => {
    const taskId = manager.registerAgentTask(
      Promise.resolve({ result: 'SUBAGENT-FINAL-SUMMARY\n' }),
      'agent output test',
      {
        agentId: 'agent-child',
        subagentType: 'coder',
      },
    );
    await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

    const result = await executeTool(tool, context('c_agent_output', { task_id: taskId }));

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('kind: agent');
    expect(content).toContain('agent_id: agent-child');
    expect(content).toContain('actual_subagent_type: coder');
    expect(content).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(content).not.toMatch(/^pid:/m);
    expect(content).not.toMatch(/^command:/m);
    expect(content).not.toMatch(/^exit_code:/m);
  });

  it('reads persisted output for a task loaded after restart', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-'));
    try {
      const writer = new BackgroundProcessManager();
      writer.attachSessionDir(sessionDir);
      const taskId = writer.register(
        immediateProcess(0, 'persisted output\n'),
        'echo persisted output',
        'persist output test',
      );

      await expect(writer.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const reader = new BackgroundProcessManager();
      reader.attachSessionDir(sessionDir);
      const { result, content } = await waitForPersistedOutput(reader, taskId, 'persisted output');

      expect(result.isError).toBe(false);
      expect(content).toContain('status: completed');
      expect(content).toContain('output_path:');
      expect(content).toContain('persisted output');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('reports awaiting_approval as not_ready when block=false', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'approval output test');
    manager.markAwaitingApproval(taskId, 'waiting for root approval');

    const result = await executeTool(tool, context('c_awaiting_output', { task_id: taskId }));

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('retrieval_status: not_ready');
    expect(content).toContain('status: awaiting_approval');
  });

  it('settles an already-exited process before reporting non-blocking output', async () => {
    const proc = processExitingAfterTimer(143, 0);
    const taskId = manager.register(proc, 'sleep 60', 'external kill output test');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const result = await executeTool(tool, context('c_just_exited_output', { task_id: taskId }));

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('retrieval_status: success');
    expect(content).toContain('status: failed');
    expect(content).toContain('exit_code: 143');
  });

  it('waits on awaiting_approval when block=true and reports timeout if still non-terminal', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'approval blocking output test');
    manager.markAwaitingApproval(taskId, 'waiting for root approval');

    const result = await executeTool(tool,
      context('c_awaiting_output_block', { task_id: taskId, block: true, timeout: 0 }),
    );

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('retrieval_status: timeout');
    expect(content).toContain('status: awaiting_approval');
  });
});

describe('TaskOutputTool — large output truncation + paging protocol', () => {
  let sessionDir: string | undefined;

  afterEach(async () => {
    if (sessionDir !== undefined) {
      await rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  it('truncates output > 32 KiB to a tail preview and reports paging metadata', async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-trunc-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      // 200 KiB of distinct content: head marker ... tail marker.
      const head = 'HEAD-MARKER\n';
      const tail = 'TAIL-MARKER\n';
      const filler = 'x'.repeat(200 * 1024);
      const big = head + filler + tail;
      const taskId = manager.register(immediateProcess(0, big), 'echo big', 'large output test');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const tool = new TaskOutputTool(manager);
      const result = await executeTool(tool, context('c_big', { task_id: taskId }));
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      // Structured paging metadata.
      expect(content).toContain('output_truncated: true');
      expect(content).toContain(`output_size_bytes: ${String(Buffer.byteLength(big))}`);
      expect(content).toMatch(/output_preview_bytes: \d+/);
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toMatch(/full_output_hint:.*Read/);

      // Preview is the TAIL, not the head, and carries the truncation banner.
      expect(content).toContain('[Truncated. Full output:');
      expect(content).toContain('TAIL-MARKER');
      expect(content).not.toContain('HEAD-MARKER');
    } finally {
      manager._reset();
    }
  });

  it('does not silently drop the head of a > 1 MiB running task', async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-ring-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      // Stream > 1 MiB so the in-memory ring buffer (1 MiB cap) would
      // otherwise shift() away the earliest chunks.
      const chunks = [
        'FIRST-CHUNK\n',
        'a'.repeat(700 * 1024),
        'b'.repeat(700 * 1024),
        'LAST-CHUNK\n',
      ];
      const proc: KaosProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
        stdout: Readable.from(chunks),
        stderr: Readable.from([]),
        pid: 60001,
        exitCode: 0,
        wait: vi.fn().mockResolvedValue(0) as KaosProcess['wait'],
        // oxlint-disable-next-line unicorn/no-useless-undefined
        kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
      };
      const totalBytes = chunks.reduce((s, c) => s + Buffer.byteLength(c), 0);
      const taskId = manager.register(proc, 'echo huge', 'huge running output');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const tool = new TaskOutputTool(manager);
      const result = await executeTool(tool, context('c_huge', { task_id: taskId }));
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      // The reported size is the FULL disk size — nothing was dropped.
      expect(content).toContain(`output_size_bytes: ${String(totalBytes)}`);
      expect(content).toContain('output_truncated: true');
    } finally {
      manager._reset();
    }
  });

  it('exposes paging guidance (Read + output_path) in the tool description', () => {
    const tool = new TaskOutputTool(new BackgroundProcessManager());
    const desc = tool.description;
    // Guideline 6 from the parity source: when the preview is truncated,
    // page the full log with the `Read` tool and the returned output_path.
    expect(desc).toContain('Read');
    expect(desc).toContain('output_path');
    expect(desc.toLowerCase()).toContain('truncat');
    // Must not leak the Python tool name.
    expect(desc).not.toContain('ReadFile');
  });

  it('does not mark small output (< 32 KiB) as truncated', async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-small-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      const small = 'small output line\n';
      const taskId = manager.register(immediateProcess(0, small), 'echo small', 'small test');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const tool = new TaskOutputTool(manager);
      const result = await executeTool(tool, context('c_small', { task_id: taskId }));
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      expect(content).toContain('output_truncated: false');
      expect(content).not.toContain('[Truncated. Full output:');
      expect(content).toContain('small output line');
      expect(content).toContain(`output_size_bytes: ${String(Buffer.byteLength(small))}`);
    } finally {
      manager._reset();
    }
  });

  it('flags truncation when the tail window starts mid-multibyte character', async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-utf8-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      // A 3-byte char at the head, then ASCII filler so the log is exactly
      // one byte over the 32 KiB preview window. The tail window therefore
      // starts at byte offset 1 — inside the leading multibyte char — so
      // its first bytes decode to replacement chars (each 3 bytes in
      // UTF-8). Counting decoded-string bytes would overshoot the real
      // window size and mis-report this truncated output as untruncated.
      const previewWindow = 32 * 1024;
      const text = '中' + 'a'.repeat(previewWindow - 2);
      const sizeBytes = Buffer.byteLength(text);
      expect(sizeBytes).toBe(previewWindow + 1);

      const taskId = manager.register(immediateProcess(0, text), 'echo utf8', 'utf8 boundary test');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const tool = new TaskOutputTool(manager);
      const result = await executeTool(tool, context('c_utf8', { task_id: taskId }));
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      expect(content).toContain(`output_size_bytes: ${String(sizeBytes)}`);
      expect(content).toContain('output_truncated: true');
      expect(content).toContain(`output_preview_bytes: ${String(previewWindow)}`);
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('[Truncated. Full output:');
    } finally {
      manager._reset();
    }
  });

  it('keeps preview and metadata consistent from a single log-size snapshot', async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-grow-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      // A 40 KiB ASCII log — larger than the 32 KiB preview window.
      const big = 'a'.repeat(40 * 1024);
      const taskId = manager.register(immediateProcess(0, big), 'echo grow', 'growing output');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      // Simulate the race: the size snapshot driving the metadata is taken
      // while the log is still smaller (30000 bytes) than its real on-disk
      // size (40 KiB) — e.g. a running task that grew after flushOutput().
      // The preview window and the reported metadata must agree regardless.
      vi.spyOn(manager, 'getOutputSizeBytes').mockResolvedValue(30_000);

      const result = await executeTool(new TaskOutputTool(manager),
        context('c_grow', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      // The [output] section must contain exactly output_preview_bytes
      // bytes — never a 32 KiB tail paired with stale, smaller metadata.
      const previewBytesMatch = content.match(/output_preview_bytes: (\d+)/);
      expect(previewBytesMatch).not.toBeNull();
      const marker = '[output]\n';
      const outputSection = content.slice(content.indexOf(marker) + marker.length);
      expect(Buffer.byteLength(outputSection)).toBe(Number(previewBytesMatch![1]));
    } finally {
      vi.restoreAllMocks();
      manager._reset();
    }
  });
});

describe('TaskOutputTool — terminal metadata fields', () => {
  it('exposes stop_reason and terminal_reason for an agent task aborted by its deadline', async () => {
    const manager = new BackgroundProcessManager();
    try {
      // An agent task whose completion never resolves: the external deadline
      // fires and finalizes the task with a timeout stop reason.
      const taskId = manager.registerAgentTask(
        new Promise<{ result: string }>(() => {}),
        'slow agent',
        {
          timeoutMs: 1,
        },
      );
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({
        status: 'failed',
        stopReason: BACKGROUND_TASK_TIMEOUT_STOP_REASON,
      });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_timeout', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);
      expect(content).toContain(`stop_reason: ${BACKGROUND_TASK_TIMEOUT_STOP_REASON}`);
      expect(content).toContain('terminal_reason: timed_out');
      expect(content).not.toContain('timed_out:');
    } finally {
      manager._reset();
    }
  });

  it('exposes stop_reason and terminal_reason for a task stopped via TaskStop', async () => {
    const manager = new BackgroundProcessManager();
    try {
      const proc = pendingProcess();
      const taskId = manager.register(proc, 'sleep 60', 'stoppable task');
      await manager.stop(taskId, 'operator cancelled');
      expect(manager.getTask(taskId)).toMatchObject({
        status: 'killed',
        stopReason: 'operator cancelled',
      });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_stopped', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);
      expect(content).toContain('stop_reason: operator cancelled');
      expect(content).toContain('terminal_reason: stopped');
    } finally {
      manager._reset();
    }
  });

  it('omits stop_reason / terminal_reason for a normally completed task', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-meta-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      const taskId = manager.register(immediateProcess(0, 'done\n'), 'echo done', 'normal task');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_normal', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);
      expect(content).not.toContain('timed_out:');
      expect(content).not.toContain('stop_reason:');
      expect(content).not.toContain('terminal_reason:');
    } finally {
      manager._reset();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('TaskOutputTool — full-output guidance', () => {
  it('does not advertise an output_path when the persisted log file does not exist', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-empty-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      const taskId = manager.register(immediateProcess(0), 'sleep 1', 'silent task');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_no_output_file', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      expect(content).not.toContain('output_path:');
      expect(content).toContain('output_size_bytes: 0');
      expect(content).toContain('full_output_available: false');
    } finally {
      manager._reset();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('emits full_output_available / full_output_tool even when output is not truncated', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-untrunc-'));
    const manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
    try {
      const small = 'small output line\n';
      const taskId = manager.register(immediateProcess(0, small), 'echo small', 'small test');
      await expect(manager.wait(taskId, 5_000)).resolves.toMatchObject({ status: 'completed' });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_untrunc', { task_id: taskId }),
      );
      expect(result.isError).toBe(false);
      const content = toolContentString(result);

      expect(content).toContain('output_truncated: false');
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toMatch(/full_output_hint:.*Read/);
    } finally {
      manager._reset();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('TaskStopTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskStopTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskStop"', () => {
    expect(tool.name).toBe('TaskStop');
  });

  it('description warns about destructive side effects and usage constraints', () => {
    const description = tool.description;
    // Only use when cancellation is genuinely required.
    expect(description).toContain('TaskOutput');
    expect(description.toLowerCase()).toContain('cancel');
    // Destructive risk warning.
    expect(description.toLowerCase()).toContain('destructive');
    expect(description.toLowerCase()).toContain('side effect');
    // Already-finished tasks just return current status.
    expect(description.toLowerCase()).toContain('already');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(tool, context('c1', { task_id: 'bash-unknown0' }));
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('stops a running task', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'stop test');
    const result = await executeTool(tool,
      context('c2', { task_id: taskId, reason: 'custom stop reason' }),
    );
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('killed');
    expect(toolContentString(result)).toContain('custom stop reason');
    expect(manager.getTask(taskId)?.stopReason).toBe('custom stop reason');
  });

  it('stops an awaiting_approval task', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'approval stop test');
    manager.markAwaitingApproval(taskId, 'waiting for root approval');

    const result = await executeTool(tool, context('c_awaiting_stop', { task_id: taskId }));

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('status: killed');
    expect(manager.getTask(taskId)?.approvalReason).toBeUndefined();
  });

  it('persists stop reason when attached to a session directory', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-reason-'));
    try {
      const writer = new BackgroundProcessManager();
      writer.attachSessionDir(sessionDir);
      const taskId = writer.register(pendingProcess(), 'sleep 60', 'persist stop reason test');

      const result = await executeTool(new TaskStopTool(writer),
        context('c_stop_reason', { task_id: taskId, reason: 'operator cancelled' }),
      );
      expect(result.isError).toBe(false);

      const reader = new BackgroundProcessManager();
      reader.attachSessionDir(sessionDir);
      await reader.loadFromDisk();
      expect(reader.getTask(taskId)?.stopReason).toBe('operator cancelled');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  // The empty-string case is the core of the fix: `args.reason ?? default`
  // does NOT coalesce `''` (since `'' ?? x === ''`), so the implementation
  // must trim-and-`||` instead. An explicit `''` case guards that, alongside
  // a whitespace-only string and an omitted `reason`.
  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'empty reason test');
    const result = await executeTool(tool,
      context('c_empty_reason', { task_id: taskId, reason }),
    );
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('reason: Stopped by TaskStop');
    expect(manager.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  });

  it('returns info when task is already in terminal state', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'terminal test');

    // Let wait() settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const result = await executeTool(tool, context('c3', { task_id: taskId }));
    expect(result.isError).toBe(false);
    // Terminal-state path uses the same structured multi-line format as the
    // normal stop path: task_id / status / reason — each on its own line.
    const lines = toolContentString(result).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`task_id: ${taskId}`);
    expect(lines[1]).toBe('status: completed');
    // A cleanly exited task has no stopReason, so this exercises the
    // placeholder fallback used when `stopReason` is undefined.
    expect(lines[2]).toBe('reason: Task already in terminal state');
  });

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-blank-stored-reason-'));
    try {
      // A task persisted by an older build (or a caller that passed `''`)
      // can carry a blank `stop_reason` on disk; the terminal-state branch
      // must not surface it as a bare `reason: ` line.
      await writeTask(sessionDir, {
        task_id: 'bash-deadbeef',
        command: 'sleep 60',
        description: 'legacy blank reason',
        pid: 999,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_001,
        exit_code: null,
        status: 'killed',
        stop_reason: '',
      });
      const reader = new BackgroundProcessManager();
      reader.attachSessionDir(sessionDir);
      await reader.loadFromDisk();

      const result = await executeTool(
        new TaskStopTool(reader),
        context('c_blank_stored', { task_id: 'bash-deadbeef' }),
      );

      expect(result.isError).toBe(false);
      const lines = toolContentString(result).trim().split('\n');
      expect(lines[2]).toBe('reason: Task already in terminal state');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

// ── py-aligned envelope contracts ──────────────────────────────────────

describe('TaskOutputTool — py envelope contract', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskOutputTool(manager);

  afterEach(() => {
    manager._reset();
  });

  // Completed task envelope must include: retrieval_status:success +
  // status:completed + output_path + output_truncated:false +
  // full_output_tool: Read + full_output_hint.
  // TS only emits the full_output_tool / hint pair when a persisted log
  // exists, so the manager must be attached to a session dir.
  it('completed task returns a rich envelope with output_truncated/full_output_tool/full_output_hint', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-env-'));
    try {
      const m2 = new BackgroundProcessManager();
      m2.attachSessionDir(sessionDir);
      const t = new TaskOutputTool(m2);
      const proc = immediateProcess(0, 'build line 1\nbuild line 2\n');
      const taskId = m2.register(proc, 'make build', 'completed envelope');
      await m2.wait(taskId, 5_000);
      const result = await executeTool(t, context('c_env', { task_id: taskId, block: true, timeout: 1 }));
      expect(result.isError).toBe(false);
      const text = toolContentString(result);
      expect(text).toContain('retrieval_status: success');
      expect(text).toContain('status: completed');
      expect(text).toContain('output_truncated: false');
      // TS uses `Read` rather than Python's `ReadFile`; test asserts the
      // TS-native tool name (see decision in PR description).
      expect(text).toContain('full_output_tool: Read');
      expect(text).toContain('full_output_hint:');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  // block omitted defaults to non-blocking → not_ready + a brief
  // "Task snapshot retrieved." surface.
  it('omitting block defaults to non-blocking with a "Task snapshot retrieved." brief', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'default block');
    const result = await executeTool(tool, context('c_default', { task_id: taskId }));
    expect(result.isError).toBe(false);
    const text = toolContentString(result);
    expect(text).toContain('retrieval_status: not_ready');
    expect(text).toContain('status: running');
    // Py: result.message == "Task snapshot retrieved."
    const message = (result as unknown as { message?: string }).message;
    expect(message).toBe('Task snapshot retrieved.');
  });

  // block=True + timeout=0 on a still-running task surfaces
  // retrieval_status:timeout (not_ready is for non-blocking only).
  it('block=true with timeout=0 on a running task surfaces retrieval_status:timeout', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'blocking timeout');
    const result = await executeTool(
      tool,
      context('c_block_timeout', { task_id: taskId, block: true, timeout: 0 }),
    );
    expect(result.isError).toBe(false);
    const text = toolContentString(result);
    expect(text).toContain('retrieval_status: timeout');
    expect(text).toContain('status: running');
  });

  // Lookup of a non-existent task returns error AND must not create a
  // ghost entry or any task file on disk.
  it('lookup of a non-existent task does not pollute the store', async () => {
    const { mkdtemp, readdir, rm } = await import('node:fs/promises');
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-missing-'));
    try {
      const m2 = new BackgroundProcessManager();
      m2.attachSessionDir(sessionDir);
      const t = new TaskOutputTool(m2);
      const r = await executeTool(t, context('c_missing', { task_id: 'bash-noex0000' }));
      expect(r.isError).toBe(true);
      expect(toolContentString(r)).toContain('Task not found');
      const top = await readdir(sessionDir);
      expect(top.includes('tasks')).toBe(false);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  // For a task that timed out (failed terminal state with timeout stop reason),
  // the envelope surfaces: status:failed + stop_reason:Timed out +
  // terminal_reason:timed_out. The Python contract also includes
  // `interrupted: true` and a standalone `reason:` line; TS deliberately
  // omits both — `interrupted` is not modeled, and the categorical
  // `terminal_reason` is preferred over a separate prose `reason` field
  // (PR#243 by-design exclusion). The TS contract assertions below
  // suffice; the dropped assertions are documented for traceability.
  it('a timed-out task surfaces the full timeout contract', async () => {
    // Build a manager state where status=failed and stopReason=Timed out.
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'will time out', {
      timeoutMs: 50,
    });
    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBe(BACKGROUND_TASK_TIMEOUT_STOP_REASON);

    const result = await executeTool(
      tool,
      context('c_timeout_contract', { task_id: taskId, block: true, timeout: 1 }),
    );
    expect(result.isError).toBe(false);
    const text = toolContentString(result);
    expect(text).toContain('status: failed');
    expect(text).toContain(`stop_reason: ${BACKGROUND_TASK_TIMEOUT_STOP_REASON}`);
    expect(text).toContain('terminal_reason: timed_out');
    expect(text).not.toContain('timed_out:');
  });

  // Oversized output (>32KB): the envelope truncates to a preview
  // (32KB tail) + output_path + output_preview_bytes:32768 +
  // output_size_bytes + output_truncated:true + a "Truncated. Full
  // output: ${path}" banner + ReadFile hint with line_offset/n_lines.
  // (gap #5.)
  it('oversized output surfaces a truncated preview and full log path', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-trunc-'));
    try {
      const big = 'first marker\n' + 'x'.repeat(33 * 1024) + '\nlast marker\n';
      const m2 = new BackgroundProcessManager();
      m2.attachSessionDir(sessionDir);
      const taskId = m2.register(immediateProcess(0, big), 'big', 'big output');
      await m2.wait(taskId, 5_000);

      const t = new TaskOutputTool(m2);
      const r = await executeTool(t, context('c_trunc', { task_id: taskId, block: true, timeout: 1 }));
      expect(r.isError).toBe(false);
      const text = toolContentString(r);
      expect(text).toContain('output_preview_bytes: 32768');
      expect(text).toContain('output_truncated: true');
      expect(text).toMatch(/output_size_bytes: \d+/);
      expect(text).toMatch(/\[Truncated\. Full output: .*\]/);
      // Tail preview should keep the last marker, drop the head.
      expect(text).toContain('last marker');
      expect(text).not.toContain('first marker');
      // TS uses prose ("Use the Read tool with the output_path ...
      // parameters: path, line_offset, n_lines") instead of Python's
      // literal `ReadFile(path=..., line_offset=1, n_lines=N)` call
      // syntax. Assert the keywords that signal the same intent.
      expect(text).toMatch(/Read/);
      expect(text).toMatch(/line_offset/);
      expect(text).toMatch(/n_lines/);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('TaskListTool — py envelope contract', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskListTool(manager);

  afterEach(() => {
    manager._reset();
  });

  // TaskList(active_only=True) emits an 'active_background_tasks: N'
  // header so the LLM can see the count distinct from the per-task body.
  it('active_only=true emits an active_background_tasks header', async () => {
    const proc = pendingProcess();
    manager.register(proc, 'sleep 60', 'running');
    const result = await executeTool(tool, context('c_active_header', { active_only: true }));
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('active_background_tasks: 1');
  });

  // TaskList(active_only=False, limit=1) emits a 'background_tasks: N'
  // header and honours the limit.
  it('active_only=false emits a background_tasks header and honours limit', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'done');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');
    const result = await executeTool(
      tool,
      context('c_all_header', { active_only: false, limit: 1 }),
    );
    expect(result.isError).toBe(false);
    const text = toolContentString(result);
    expect(text).toContain('background_tasks: 1');
    expect(text).toContain(taskId);
  });
});

// task-list / task-stop / task-output description copy contracts —
// the LLM-facing description text must mention specific keywords so
// agents know when to reach for each tool.

describe('background tool descriptions', () => {
  const manager = new BackgroundProcessManager();
  afterEach(() => {
    manager._reset();
  });

  it('TaskOutput description mentions background tasks, block param, output_path, Read fallback', () => {
    const tool = new TaskOutputTool(manager);
    const desc = tool.description;
    expect(desc).toMatch(/background/i);
    expect(desc).toContain('Agent(run_in_background=true)');
    expect(desc).toMatch(/block/);
    expect(desc).toMatch(/output_path/);
    // TS uses `Read` rather than Python's `ReadFile` for the full-log
    // fallback tool; assert the TS-native name.
    expect(desc).toMatch(/Read/);
  });

  it('TaskList description mentions active_only default, read-only, plan-mode safe', () => {
    const tool = new TaskListTool(manager);
    const desc = tool.description;
    expect(desc).toMatch(/active_only/);
    expect(desc).toMatch(/read[- ]only/i);
    expect(desc).toMatch(/plan[- ]mode/i);
    expect(desc).toMatch(/background tasks?/i);
  });

  it('TaskStop description clarifies destructive cancellation and is generic (not bash-only)', () => {
    const tool = new TaskStopTool(manager);
    const desc = tool.description;
    expect(desc).toMatch(/destructive/i);
    expect(desc).toMatch(/cancel/i);
    // TS phrasing uses "general-purpose"; Python uses "generic". Accept
    // either since they convey the same "not bash-specific" intent.
    expect(desc).toMatch(/general[-\s]?purpose|generic/i);
    expect(desc).not.toMatch(/bash[- ]?only/i);
  });
});

// Behavioral coverage for partial-output reads. Python exposes
// `read_output(offset, max_bytes) → {text, next_offset, eof}` and a
// dedicated `tail_output(max_bytes, max_lines)` on the BPM. TS solves
// the same problems through different surfaces: byte-range reads go
// through `readOutputBytesFromDisk` and line-bounded tails go through
// `getOutput(taskId, tail)`. These tests exercise the TS surface to
// lock down the underlying behavior, not the Python method names.
describe('background store — partial output reads (TS surface)', () => {
  const manager = new BackgroundProcessManager();
  afterEach(() => {
    manager._reset();
  });

  it('readOutputBytesFromDisk returns the requested byte window', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-range-'));
    try {
      const m2 = new BackgroundProcessManager();
      m2.attachSessionDir(sessionDir);
      const proc = immediateProcess(0, 'line1\nline2\nline3\n');
      const taskId = m2.register(proc, 'echo lines', 'range read');
      await m2.wait(taskId, 5_000);
      // Behavior contract: byte offset 0, length 7 returns "line1\nl".
      const chunk = await m2.readOutputBytesFromDisk(taskId, 0, 7);
      expect(chunk).toBe('line1\nl');
      // A second window that starts where the first ended returns the
      // next slice — i.e. callers can paginate by tracking the offset.
      const next = await m2.readOutputBytesFromDisk(taskId, 7, 7);
      expect(next).toBe('ine2\nli');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('getOutput with a tail arg returns the last N characters', async () => {
    const proc = immediateProcess(0, 'line1\nline2\nline3\n');
    const taskId = manager.register(proc, 'echo lines', 'tail read');
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    // Behavior contract: TS's tail is character-bounded (Python's was
    // line-bounded; the line-tail concern is satisfied at the
    // task-output.ts layer instead). Asking for the last 12 chars of
    // "line1\nline2\nline3\n" yields "line2\nline3\n".
    const tail = manager.getOutput(taskId, 12);
    expect(tail).toBe('line2\nline3\n');
  });
});

// A background agent paused in `awaiting_approval` can be killed via
// the TaskStop tool — the task transitions to `killed`. The
// downstream side effect (clearing pending approvals on the
// ApprovalRuntime) lives outside the BPM in TS by design and is
// covered by ApprovalRuntime's own tests; this test scopes only the
// status transition through the tool boundary.
describe('TaskStopTool on awaiting-approval agents', () => {
  const manager = new BackgroundProcessManager();
  const stop = new TaskStopTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('TaskStop on an awaiting_approval agent transitions the task to killed', async () => {
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<{ result: string }>((_res, rej) => {
      rejectCompletion = rej;
    });
    const taskId = manager.registerAgentTask(completion, 'awaiting kill', {
      abort: () => {
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        rejectCompletion(abortError);
      },
    });
    manager.markAwaitingApproval(taskId, 'edit file');
    const result = await executeTool(stop, context('c_stop_awaiting', { task_id: taskId }));
    expect(result.isError).toBe(false);
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('killed');
  });
});

// Reuse imports from the top of the file. The helper-suite needs
// mkdtemp/tmpdir/join — already imported at the top.
