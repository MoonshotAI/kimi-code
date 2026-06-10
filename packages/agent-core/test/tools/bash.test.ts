import { PassThrough, Readable, type Writable } from 'node:stream';

import type { Environment, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { type BashInput, BashInputSchema, BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager, registerProcess } from '../agent/background/helpers';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

const windowsBashEnv: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
};

function processWithOutput(
  options: {
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly exitCode?: number;
    readonly wait?: () => Promise<number>;
    readonly kill?: (signal?: NodeJS.Signals) => Promise<void>;
  } = {},
): KaosProcess {
  const exitCode = options.exitCode ?? 0;
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from(options.stdout === undefined ? [] : [options.stdout]),
    stderr: Readable.from(options.stderr === undefined ? [] : [options.stderr]),
    pid: 123,
    exitCode,
    wait: vi.fn(options.wait ?? (async () => exitCode)),
    kill: vi.fn(options.kill ?? (async () => {})),
  };
}

function processWithInterleavedOutput(
  events: ReadonlyArray<{
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
    readonly delayMs: number;
  }>,
  exitCode = 0,
): KaosProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lastDelay = Math.max(...events.map((event) => event.delayMs), 0);
  const waitPromise = new Promise<number>((resolve) => {
    for (const event of events) {
      setTimeout(() => {
        const target = event.stream === 'stdout' ? stdout : stderr;
        target.write(event.text);
      }, event.delayMs);
    }
    setTimeout(() => {
      stdout.end();
      stderr.end();
      resolve(exitCode);
    }, lastDelay + 1);
  });

  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 124,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
  };
}

function processWithVisibleExitBeforeWait(exitCode = 0): {
  proc: KaosProcess;
  finishWait: () => void;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: KaosProcess = {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 125,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
  };

  return {
    proc,
    finishWait: () => {
      resolveWait(exitCode);
    },
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

function processThatNeverExits(): KaosProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 126,
    exitCode: null,
    wait: vi.fn(async () => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
  };
}

function processWithOpenStreamsThatExitOnKill(): KaosProcess {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });

  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 127,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {
      currentExitCode = 143;
      resolveWait(143);
    }),
  };
}

function context(args: BashInput, signal = new AbortController().signal) {
  return { turnId: '0', toolCallId: 'call_bash', args, signal };
}

describe('BashTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new BashTool(createFakeKaos({ osEnv: posixEnv }), '/workspace');

    expect(tool.name).toBe('Bash');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });
    expect(BashInputSchema.safeParse({ command: 'echo hello' }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 0 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300 }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 301 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_000 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_001 }).success).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_400,
      }).success,
    ).toBe(true);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_401,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 600_000,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        disable_timeout: true,
      }).success,
    ).toBe(true);
  });

  it('describes the cwd, command, run_in_background, description, and disable_timeout parameters', () => {
    const tool = new BashTool(createFakeKaos({ osEnv: posixEnv }), '/workspace');
    const properties = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;

    for (const name of [
      'cwd',
      'command',
      'run_in_background',
      'description',
      'disable_timeout',
    ] as const) {
      const description = properties[name]?.description;
      expect(description, `${name} should have a non-empty description`).toBeTruthy();
      expect((description ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a default timeout in the JSON Schema', () => {
    const tool = new BashTool(createFakeKaos({ osEnv: posixEnv }), '/workspace');
    const properties = (tool.parameters as { properties: Record<string, { default?: number }> })
      .properties;

    expect(properties['timeout']?.default).toBe(60);
  });

  it('interprets small timeout values as seconds at runtime', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const tool = new BashTool(
        createFakeKaos({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
        '/workspace',
      );

      const running = executeTool(tool, context({ command: 'sleep 3', timeout: 2 }));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const result = await running;

      expect(proc.kill).toHaveBeenCalled();
      expect(result.output).toContain('Command killed by timeout (2s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the available commands section and the /tasks hint', () => {
    const tool = new BashTool(
      createFakeKaos({ osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );

    expect(tool.description).toContain('Commands available');
    expect(tool.description).toContain('/tasks');
  });

  it('runs through execWithEnv, injects cwd, noninteractive env, and closes stdin', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 60 }));

    expect(execWithEnv).toHaveBeenCalledTimes(1);
    const [argv, env] = execWithEnv.mock.calls[0]!;
    expect(argv).toEqual(['/bin/bash', '-c', "cd '/workspace' && printf ok"]);
    expect(env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
      message: 'Command executed successfully.',
    });
  });

  it('uses args.cwd when provided', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(processWithOutput({ stdout: 'sub\n' }));
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    await executeTool(tool, context({ command: 'pwd', cwd: '/tmp/project', timeout: 60 }));

    expect(execWithEnv.mock.calls[0]?.[0]).toEqual(['/bin/bash', '-c', "cd '/tmp/project' && pwd"]);
  });

  it('uses Git Bash semantics on Windows', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: windowsBashEnv }),
      'C:\\Users\\me\\project',
    );

    const result = await executeTool(tool, context({ command: 'echo ok 2>nul', timeout: 60 }));

    expect(execWithEnv).toHaveBeenCalledTimes(1);
    const [argv, env] = execWithEnv.mock.calls[0]!;
    expect(argv).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '-c',
      "cd '/c/Users/me/project' && echo ok 2>/dev/null",
    ]);
    expect(env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
      message: 'Command executed successfully.',
    });
  });

  it('returns stderr and marks non-zero exit codes as tool errors', async () => {
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi
          .fn()
          .mockResolvedValue(processWithOutput({ stderr: 'boom\n', exitCode: 2 })),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'exit 2', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      message: 'Command failed with exit code: 2.',
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('boom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns both stdout and stderr when a command succeeds', async () => {
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi
          .fn()
          .mockResolvedValue(processWithOutput({ stdout: 'out\n', stderr: 'warn\n' })),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'mixed', timeout: 60 }));

    expect(result).toMatchObject({
      output: 'out\nwarn\n',
      isError: false,
      message: 'Command executed successfully.',
    });
  });

  it('returns both stdout and stderr when a command fails', async () => {
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi.fn().mockResolvedValue(
          processWithOutput({
            stdout: 'partial\n',
            stderr: 'boom\n',
            exitCode: 2,
          }),
        ),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'mixed fail', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      message: 'Command failed with exit code: 2.',
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('partial\nboom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('preserves foreground stdout and stderr arrival order', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithInterleavedOutput([
        { stream: 'stderr', text: 'err-first\n', delayMs: 0 },
        { stream: 'stdout', text: 'out-second\n', delayMs: 5 },
        { stream: 'stderr', text: 'err-third\n', delayMs: 10 },
      ]);
      const tool = new BashTool(
        createFakeKaos({
          execWithEnv: vi.fn().mockResolvedValue(proc),
          osEnv: posixEnv,
        }),
        '/workspace',
      );

      const resultPromise = executeTool(tool, context({ command: 'mixed', timeout: 60 }));
      await vi.advanceTimersByTimeAsync(11);

      const result = await resultPromise;
      expect(result).toMatchObject({
        isError: false,
        output: 'err-first\nout-second\nerr-third\n',
        message: 'Command executed successfully.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const execWithEnv = vi.fn();
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const result = await executeTool(tool, context({ command: 'echo nope' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Aborted before command started' });
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('kills the process and returns an abort result when aborted while running', async () => {
    let resolveWait: (code: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = processWithOutput({
      wait: async () => waitPromise,
      kill: async () => {
        resolveWait(143);
      },
    });
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const running = executeTool(tool, context({ command: 'sleep 10' }, controller.signal));
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by user');
  });

  it('requires a background manager and description for background commands', async () => {
    const proc = processWithOutput();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const withoutManager = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const unavailable = await executeTool(withoutManager,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.output).toContain('Background execution is not available');
    expect(execWithEnv).not.toHaveBeenCalled();

    const manager = createBackgroundManager().manager;
    const withManager = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      manager,
    );
    const missingDescription = await executeTool(withManager,
      context({ command: 'sleep 10', run_in_background: true }),
    );

    expect(missingDescription).toMatchObject({ isError: true });
    expect(missingDescription.output).toContain('description is required');
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('registers background commands and returns a task id', async () => {
    const proc = processWithOutput();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const manager = createBackgroundManager().manager;
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

    const result = await executeTool(tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'long running task' }),
    );

    expect(result.output).toMatch(/task_id: bash-[0-9a-z]{8}/);
    expect(result.output).toContain('automatic_notification: true');
    expect(manager.list(false)).toHaveLength(1);
  });

  it('kills a spawned background command when the task limit is reached', async () => {
    const manager = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    registerProcess(manager, processWithOutput(), 'sleep 10', 'existing task');
    const rejectedProc = processWithOutput();
    const execWithEnv = vi.fn().mockResolvedValue(rejectedProc);
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

    const result = await executeTool(tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(execWithEnv).toHaveBeenCalledTimes(1);
    expect(rejectedProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects one of two concurrent background commands when the task limit is reached', async () => {
    const manager = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const execWithEnv = vi
      .fn()
      .mockResolvedValueOnce(firstProc)
      .mockResolvedValueOnce(secondProc);
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

    const first = executeTool(tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'first task' }),
    );
    const second = executeTool(tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    const results = await Promise.all([first, second]);

    expect(execWithEnv).toHaveBeenCalledTimes(2);
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('uses Git Bash semantics and rejects the concurrent command at the task limit', async () => {
    const manager = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const execWithEnv = vi
      .fn()
      .mockResolvedValueOnce(firstProc)
      .mockResolvedValueOnce(secondProc);
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: windowsBashEnv }),
      'C:\\Users\\me\\project',
      manager,
    );

    const first = executeTool(tool,
      context({
        command: 'echo ok 2>nul',
        run_in_background: true,
        description: 'first task',
      }),
    );
    const second = executeTool(tool,
      context({
        command: 'echo second',
        run_in_background: true,
        description: 'second task',
      }),
    );

    const results = await Promise.all([first, second]);

    expect(execWithEnv).toHaveBeenCalledTimes(2);
    const [argv, env] = execWithEnv.mock.calls[0]!;
    expect(argv).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '-c',
      "cd '/c/Users/me/project' && echo ok 2>/dev/null",
    ]);
    expect(env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('does not timeout-stop a background task whose exit is visible before wait settles', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finishWait, markExited } = processWithVisibleExitBeforeWait(0);
      const execWithEnv = vi.fn().mockResolvedValue(proc);
      const manager = createBackgroundManager().manager;
      const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

      const result = await executeTool(tool,
        context({
          command: 'sleep 10',
          run_in_background: true,
          description: 'exit before close',
          timeout: 1,
        }),
      );
      expect(typeof result.output).toBe('string');
      if (typeof result.output !== 'string') throw new Error('Expected string tool output.');
      const taskId = result.output.match(/task_id: (bash-[0-9a-z]{8})/)?.[1];
      expect(taskId).toBeDefined();

      markExited();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(proc.kill).not.toHaveBeenCalled();

      finishWait();
      await vi.runAllTimersAsync();

      expect(manager.getTask(taskId!)?.status).toBe('completed');
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout-stops a background task after the default 10 minute deadline', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const execWithEnv = vi.fn().mockResolvedValue(proc);
      const manager = createBackgroundManager().manager;
      const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

      const result = await executeTool(tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'default deadline',
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not timeout-stop a background task when disable_timeout is true', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const execWithEnv = vi.fn().mockResolvedValue(proc);
      const manager = createBackgroundManager().manager;
      const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

      const result = await executeTool(tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'no deadline',
          disable_timeout: true,
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000 + 10_000);

      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds a truncation note when stdout exceeds the cap', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi.fn().mockResolvedValue(processWithOutput({ stdout: huge })),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect((result as { message?: string }).message).toContain('Output is truncated');
  });

  it('marks the truncated output buffer with a "[...truncated]" sentinel at the cut point', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi.fn().mockResolvedValue(processWithOutput({ stdout: huge })),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('[...truncated]');
  });

  it('truncates output with the sentinel even when the command fails', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi
          .fn()
          .mockResolvedValue(processWithOutput({ stdout: huge, exitCode: 1 })),
        osEnv: posixEnv,
      }),
      '/workspace',
    );

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('[...truncated]');
    expect(output).toContain('Output is truncated');
  });

  it('reports a timed-out command with both message and brief lines', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const tool = new BashTool(
        createFakeKaos({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
        '/workspace',
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await running;

      expect(result).toMatchObject({
        isError: true,
        brief: 'Killed by timeout (1s)',
      });
      expect(result.output).toContain('Command killed by timeout (1s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports timeout instead of premature close when cleanup destroys open output streams', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithOpenStreamsThatExitOnKill();
      const tool = new BashTool(
        createFakeKaos({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
        '/workspace',
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await running;

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toMatchObject({
        isError: true,
        brief: 'Killed by timeout (1s)',
      });
      expect(result.output).toContain('Command killed by timeout (1s)');
      expect(result.output).not.toContain('Premature close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects empty-string commands at the schema layer', () => {
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
  });

  it('does not inject GIT_SSH_COMMAND into the spawn environment', async () => {
    const previous = process.env['GIT_SSH_COMMAND'];
    delete process.env['GIT_SSH_COMMAND'];
    try {
      const execWithEnv = vi.fn().mockResolvedValue(processWithOutput({ stdout: 'ok\n' }));
      const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

      await executeTool(tool, context({ command: 'true', timeout: 60 }));

      const env = execWithEnv.mock.calls[0]?.[1] as Record<string, string>;
      expect(Object.prototype.hasOwnProperty.call(env, 'GIT_SSH_COMMAND')).toBe(false);
    } finally {
      if (previous !== undefined) process.env['GIT_SSH_COMMAND'] = previous;
    }
  });

  it('reports background task startup with task_id, status, automatic_notification, and a human-shell hint', async () => {
    const proc = processWithOutput();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const manager = createBackgroundManager().manager;
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true, description: 'sleep task' }),
    );

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('task_id:');
    expect(output).toContain('status: running');
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('human_shell_hint:');
    expect(output).toContain('/tasks');
  });

  it('rejects background command without description (description-required guard)', async () => {
    const manager = createBackgroundManager().manager;
    const execWithEnv = vi.fn().mockResolvedValue(processWithOutput());
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace', manager);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('description is required');
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('rewrites nul-redirect on Windows so the spawned argv has /dev/null', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(processWithOutput({ stdout: '' }));
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: windowsBashEnv }),
      'C:\\Users\\me\\project',
    );

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const argv = execWithEnv.mock.calls[0]?.[0] as readonly string[];
    expect(argv[2]).toBe("cd '/c/Users/me/project' && ls 2>/dev/null");
  });

  it('passes nul-redirect through unchanged on Linux so the argv keeps the literal file target', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(processWithOutput({ stdout: '' }));
    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const argv = execWithEnv.mock.calls[0]?.[0] as readonly string[];
    expect(argv[2]).toBe("cd '/workspace' && ls 2>nul");
  });

  it('exposes a shell description that documents /bin/bash, TaskOutput/TaskStop, safety and efficiency sections, and background semantics', () => {
    const tool = new BashTool(
      createFakeKaos({ osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );

    const description = tool.description;
    expect(description).toContain('`bash`');
    expect(description).toContain('TaskOutput');
    expect(description).toContain('TaskStop');
    expect(description).toContain('**Guidelines for safety and security:**');
    expect(description).toContain('**Guidelines for efficiency:**');
    expect(description).toContain('run_in_background=true');
    expect(description).toContain('automatically notified');
  });
});

describe('BashTool prompt / runtime consistency', () => {
  it('reports unavailable background using only tools the prompt documents', async () => {
    const execWithEnv = vi.fn();

    // The set of background tools the prompt actually introduces — taken from
    // the background-enabled prompt, which is the only variant that documents
    // any Task* tool.
    const enabledTool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );
    const promptToolNames = new Set(
      [...enabledTool.description.matchAll(/`(Task[A-Za-z]+)`/g)].map((match) => match[1]),
    );

    const tool = new BashTool(createFakeKaos({ execWithEnv, osEnv: posixEnv }), '/workspace');
    const result = await executeTool(tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const errorToolNames = [...(result.output as string).matchAll(/\b(Task[A-Za-z]+)\b/g)].map(
      (match) => match[1],
    );

    // The unavailable-background error message must not name a tool that the
    // prompt never introduces, otherwise the model is told about a tool it
    // has no guidance for.
    for (const name of errorToolNames) {
      expect(promptToolNames).toContain(name);
    }
    expect(errorToolNames.length).toBeGreaterThan(0);
  });

  it('does not claim failure exit codes appear in a system tag', () => {
    const tool = new BashTool(createFakeKaos({ osEnv: posixEnv }), '/workspace');

    // The implementation reports failures as plain text inside the output
    // (`Command failed with exit code: N`), never via a system tag.
    expect(tool.description).not.toMatch(/exit code will be provided in a system tag/);
  });
});
