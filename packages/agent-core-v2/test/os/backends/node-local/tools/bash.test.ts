import { PassThrough, Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTaskInfo,
  type AgentTaskOutputChunk,
  type AgentTaskOutputSnapshot,
  type AgentTaskStatus,
} from '#/agent/task/task';
import { userCancellationReason } from '#/_base/utils/abort';
import { Event } from '#/_base/event';
import type { IConfigService } from '#/app/config/config';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import { stubAgentEnvironment } from '../../../../environment/stubs';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { type ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { type BashInput, BashInputSchema } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { AgentWorkspaceContextService } from '#/session/workspaceContext/agentWorkspaceContextService';
import { SessionStateService } from '#/session/state/sessionStateService';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import {
  channelsByService,
  channelsByTool,
  createTaskChannel,
} from '../../../../agent/task/stubs';
import {
  isToolDetachAck,
  LegacyExecutableToolAdapter,
  type LegacyToolAgentContext,
  memoryOutputStore,
  ToolExecutor as HandlerToolExecutor,
  type ToolExecutionHandler,
  type ToolOutputStore,
} from '#/tool/executor';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentTaskRequestService, AgentTaskService } from '#/agent/task/taskService';
import { createTaskCompletionEntry, IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { AgentTaskPersistence } from '#/agent/task/task';

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const windowsBashEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  pathClass: 'win32',
  homeDir: 'C:\\Users\\test',
  ready: Promise.resolve(),
};

function processWithOutput(
  options: {
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly exitCode?: number | null;
    readonly wait?: () => Promise<number>;
    readonly kill?: (signal?: NodeJS.Signals) => Promise<void>;
  } = {},
): IHostProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  const stderr = Readable.from(options.stderr === undefined ? [] : [options.stderr]);
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 123,
    exitCode,
    wait: vi.fn(options.wait ?? (async () => exitCode)),
    kill: vi.fn(options.kill ?? (async () => {})),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithInterleavedOutput(
  events: ReadonlyArray<{
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
    readonly delayMs: number;
  }>,
  exitCode = 0,
): IHostProcess {
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
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 124,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function pendingProcess(): {
  readonly proc: IHostProcess;
  readonly finish: (exitCode?: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveWait: (exitCode: number) => void = () => {};
  let currentExitCode: number | null = null;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (exitCode = 0): void => {
    if (currentExitCode !== null) return;
    currentExitCode = exitCode;
    stdout.end();
    stderr.end();
    resolveWait(exitCode);
  };
  return {
    proc: {
      _serviceBrand: undefined,
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 125,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: vi.fn(async () => waitPromise),
      kill: vi.fn(async () => {
        finish(143);
      }) as IHostProcess['kill'],
      dispose: vi.fn(async () => {}),
    },
    finish,
  };
}

function processWithVisibleExitBeforeWait(exitCode = 0): {
  proc: IHostProcess;
  finishWait: () => void;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 125,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
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

function processThatNeverExits(): IHostProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 126,
    exitCode: null,
    wait: vi.fn(async () => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithStreamError(options: {
  readonly stdoutError?: Error;
  readonly stderrError?: Error;
  readonly exitCode?: number;
} = {}): IHostProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const waitPromise = new Promise<number>((resolve) => {
    setTimeout(() => {
      if (options.stdoutError !== undefined) {
        stdout.emit('error', options.stdoutError);
      } else {
        stdout.end();
      }
      if (options.stderrError !== undefined) {
        stderr.emit('error', options.stderrError);
      } else {
        stderr.end();
      }
      resolve(exitCode);
    }, 1);
  });
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 128,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

function processWithOpenStreamsThatExitOnKill(): IHostProcess {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 127,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {
      currentExitCode = 143;
      resolveWait(143);
    }),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function createTestEnv(env: IHostEnvironment = posixEnv): IHostEnvironment {
  return env;
}

function createTestCtx(cwd = '/workspace'): ISessionContext {
  return makeSessionContext({
    sessionId: 's',
    workspaceId: 'w',
    sessionDir: cwd,
    sessionScope: 'sessions/w/s',
    cwd,
  });
}

function createTestRunner(proc: IHostProcess | ReturnType<typeof vi.fn>) {
  const exec = typeof proc === 'function' ? proc : vi.fn().mockResolvedValue(proc);
  const runner = { _serviceBrand: undefined, spawn: exec } as IHostProcessService;
  return { runner, exec };
}

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
function context(
  args: BashInput,
  signal = new AbortController().signal,
  onForegroundTaskStart?: (taskId: string) => void,
) {
  return { turnId: 0, toolCallId: 'call_bash', args, signal, onForegroundTaskStart };
}

async function executeTool(
  tool: BashTool,
  ctx: ReturnType<typeof context>,
): Promise<ExecutableToolResult & { readonly brief?: string }> {
  const channel = channelsByTool.get(tool)!;
  const handler = channel.raw.execute({
    type: 'function',
    id: ctx.toolCallId,
    name: 'Bash',
    arguments: JSON.stringify(ctx.args),
  }, {
    turnId: ctx.turnId,
    onForegroundTaskStart: ctx.onForegroundTaskStart,
  });
  channel.handlers.set(handler.taskId, handler);
  const onAbort = (): void => {
    void handler.stop(ctx.signal.reason);
  };
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await handler;
    if (isToolDetachAck(response)) {
      return {
        output: response.content.map((part) => part.type === 'text' ? part.text : '').join(''),
        isError: false,
        brief: response.brief,
      };
    }
    const final = await handler.wait();
    const prepared = handler.snapshot().prepared;
    const legacy = prepared?.kind === 'execute' || prepared?.kind === 'synthetic'
      ? prepared.result
      : undefined;
    const content = final.content.every((part) => part.type === 'text')
      ? final.content.map((part) => part.type === 'text' ? part.text : '').join('')
      : final.content;
    return {
      ...legacy,
      output: final.outcome.type === 'success' ? legacy?.output ?? content : content,
      isError: final.outcome.type === 'success' ? legacy?.isError : true,
    };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function stubToolPolicy(
  isToolActive: (name: string) => boolean = () => true,
): IAgentToolPolicyService {
  return {
    _serviceBrand: undefined,
    isToolActive,
  } as unknown as IAgentToolPolicyService;
}

function stubConfig(values: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

function bashTool(
  runner: IHostProcessService,
  env: IHostEnvironment = createTestEnv(),
  ctx: ISessionContext = createTestCtx(),
  background: IAgentTaskService = createTaskChannel().service,
  toolPolicy: IAgentToolPolicyService = stubToolPolicy(),
  config: IConfigService = stubConfig(),
): BashTool {
  const channel = channelsByService.get(background)!;
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = [], options) => runner.spawn(command, args, options),
  };
  const backend = Object.assign(
    new FakeEnvironment(
      { environmentId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: env.pathClass },
    ),
    {
      host: env,
      process: processService,
      shellPathBridge: env.pathClass === 'win32' ? getShellPathBridge(env) : undefined,
    },
  );
  const environment = stubAgentEnvironment(backend, { workDir: ctx.cwd });
  const tool = new BashTool(environment, ctx, stubWorkspaceContext(ctx.cwd), channel.toolExecutor, channel.outputs, toolPolicy, config);
  channel.raw.addExecute(new LegacyExecutableToolAdapter(tool));
  channelsByTool.set(tool, channel);
  return tool;
}

describe('BashTool', () => {
  it('assigns a bash-prefixed id from the real BashTool handler', async () => {
    const { service } = createTaskChannel();
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const result = await executeTool(tool, context({
      command: 'printf real-id',
      description: 'real id',
      run_in_background: true,
    }));

    const taskId = service.list(false)[0]?.taskId;
    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(result.output).toContain(`task_id: ${taskId}`);
    await expect(service.wait(taskId!)).resolves.toMatchObject({ status: 'completed' });
  });

  it('exposes current metadata and schema', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

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
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
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
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
    const properties = (tool.parameters as { properties: Record<string, { default?: number }> })
      .properties;

    expect(properties['timeout']?.default).toBe(60);
  });

  it('runs through runner.spawn, injects cwd, noninteractive env, and closes stdin', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('/bin/bash');
    expect(args).toEqual(['-c', "cd '/workspace' && printf ok"]);
    expect(execOptions?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
    });
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('keeps an explicit GIT_TERMINAL_PROMPT and defaults an unset one to 0', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'ok\n' }));
    const tool = bashTool(runner);
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    try {
      await executeTool(tool, context({ command: 'git status', timeout: 60 }));
      expect(exec.mock.calls[0]?.[2]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '1' });
    } finally {
      vi.unstubAllEnvs();
    }
    exec.mockClear();
    const previous = process.env['GIT_TERMINAL_PROMPT'];
    delete process.env['GIT_TERMINAL_PROMPT'];
    try {
      await executeTool(tool, context({ command: 'git status', timeout: 60 }));
      expect(exec.mock.calls[0]?.[2]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
    } finally {
      if (previous === undefined) delete process.env['GIT_TERMINAL_PROMPT'];
      else process.env['GIT_TERMINAL_PROMPT'] = previous;
    }
  });

  it('uses args.cwd when provided', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'sub\n' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'pwd', cwd: '/workspace/project', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toBe('/bin/bash');
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/workspace/project' && pwd"]);
  });

  it('accepts args.cwd outside the workspace roots', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'out\n' }));
    const tool = bashTool(runner);

    const result = await executeTool(
      tool,
      context({ command: 'pwd', cwd: '/outside/workspace', timeout: 60 }),
    );

    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/outside/workspace' && pwd"]);
    expect(result).toMatchObject({ output: 'out\n', isError: false });
  });

  it('uses the kaos cwd as the default working directory', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, posixEnv, createTestCtx('/var/app'));

    await executeTool(tool, context({ command: 'pwd', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toBe('/bin/bash');
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/var/app' && pwd"]);
  });

  it('resolves an omitted cwd from the bound environment workspace, not the host session cwd', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const ctx = createTestCtx('/host/session/cwd');
    const processService: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args = [], options) => runner.spawn(command, args, options),
    };
    const backend = Object.assign(
      new FakeEnvironment(
        { environmentId: 'docker-dev', generation: 'remote-one' },
        { capabilities: ['process'], pathClass: 'posix' },
      ),
      { host: createTestEnv(), process: processService },
    );
    const environment = stubAgentEnvironment(backend, { workDir: '/remote-work' });
    const sessionState = new SessionStateService();
    sessionState.contributeState(workspaceContextWorkDirKey);
    sessionState.contributeState(workspaceContextAdditionalDirsKey);
    sessionState.set(workspaceContextWorkDirKey, ctx.cwd);
    const shadow = new AgentWorkspaceContextService(sessionState, {
      current: environment,
      onDidChange: () => ({ dispose: () => {} }),
    });
    const channel = createTaskChannel();
    const tool = new BashTool(
      environment,
      ctx,
      shadow,
      channel.toolExecutor,
      channel.outputs,
      stubToolPolicy(),
      stubConfig(),
    );
    channel.raw.addExecute(new LegacyExecutableToolAdapter(tool));
    channelsByTool.set(tool, channel);

    await executeTool(tool, context({ command: 'pwd', timeout: 60 }));

    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/remote-work' && pwd"]);
  });

  it('uses Git Bash semantics on Windows', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    const result = await executeTool(tool, context({ command: 'echo ok 2>nul', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(args).toEqual(['-c', "cd '/c/Users/me/project' && echo ok 2>/dev/null"]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('returns stderr and marks non-zero exit codes as tool errors', async () => {
    const { runner } = createTestRunner(processWithOutput({ stderr: 'boom\n', exitCode: 2 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'exit 2', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('boom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns both stdout and stderr when a command succeeds', async () => {
    const { runner } = createTestRunner(processWithOutput({ stdout: 'out\n', stderr: 'warn\n' }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed', timeout: 60 }));

    expect(result).toMatchObject({
      output: 'out\nwarn\n',
      isError: false,
    });
  });

  it('returns both stdout and stderr when a command fails', async () => {
    const { runner } = createTestRunner(
      processWithOutput({ stdout: 'partial\n', stderr: 'boom\n', exitCode: 2 }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed fail', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('partial\nboom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns the service failure reason when foreground process wait rejects', async () => {
    const { runner } = createTestRunner(
      processWithOutput({
        stdout: 'partial output\n',
        exitCode: null,
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'wait fails', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'wait failed',
    });
    expect(result.output).toContain('partial output\nwait failed');
    expect(result.output).not.toContain('exit code: null');
  });

  it('preserves foreground stdout and stderr arrival order', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithInterleavedOutput([
        { stream: 'stderr', text: 'err-first\n', delayMs: 0 },
        { stream: 'stdout', text: 'out-second\n', delayMs: 5 },
        { stream: 'stderr', text: 'err-third\n', delayMs: 10 },
      ]);
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const resultPromise = executeTool(tool, context({ command: 'mixed', timeout: 60 }));
      await vi.advanceTimersByTimeAsync(11);

      const result = await resultPromise;
      expect(result).toMatchObject({
        isError: false,
        output: 'err-first\nout-second\nerr-third\n',
      });
    } finally {
      vi.useRealTimers();
    }
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
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const running = executeTool(tool, context({ command: 'sleep 3', timeout: 2 }));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
      });
      expect(result.output).toContain('task_id: bash-');
      resolveWait(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timed-out command with the timeout message when auto-background is disabled', async () => {
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
      const { runner } = createTestRunner(proc);
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        createTaskChannel().service,
        stubToolPolicy(),
        stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);
      const result = await running;

      expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
      expect(result.output).toContain('Command killed by timeout (1s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports timeout instead of premature close when cleanup destroys open output streams', async () => {
    vi.useRealTimers();
    const proc = processWithOpenStreamsThatExitOnKill();
    const { runner } = createTestRunner(proc);
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createTaskChannel().service,
      stubToolPolicy(),
      stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
    );

    const result = await executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
    expect(result.output).toContain('Command killed by timeout (1s)');
    expect(result.output).not.toContain('Premature close');
  });

  it('reports a stream read error as a tool error even when the process exits with code 0', async () => {
    vi.useRealTimers();
    const proc = processWithStreamError({
      stdoutError: new Error('SSH channel read failed'),
      exitCode: 0,
    });
    const { runner } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'remote-cmd', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('SSH channel read failed');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'echo nope' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Aborted before command started' });
    expect(exec).not.toHaveBeenCalled();
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
    const { runner } = createTestRunner(proc);
    const controller = new AbortController();
    const tool = bashTool(runner);

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

  it('caps retained output and reports the true total via spill when stdout exceeds the retention cap', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(result.output).toBe('x'.repeat(10_000_000));
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('does not shape output inline at the tool layer', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const { service } = createTaskChannel({ outputPersistenceAvailable: false });
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).not.toContain('[...truncated]');
    expect(output).not.toContain('Output is truncated');
    expect(result.spill?.suffix).toBe('Command executed successfully.');
  });

  it('appends the failure message after retained output when the command fails', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge, exitCode: 1 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output.startsWith('E'.repeat(10_000_000))).toBe(true);
    expect(output).toContain('Command failed with exit code: 1.');
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('points the spill at the persisted task log when foreground output exceeds the delivery cap', async () => {
    const fullOutput = `${'short line\n'.repeat(6_000)}tail survives\n`;
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, handlers } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    const spill = result.spill;
    expect(spill).toBeDefined();
    const taskId = /\/tasks\/(bash-[0-9a-z]{8})\/output\.log$/.exec(
      spill!.outputPath!,
    )?.[1];
    expect(taskId).toBeTruthy();
    expect(handlers.get(taskId!)?.output().path).toBe(spill!.outputPath);
    expect(spill!.totalChars).toBe(fullOutput.length);
    expect(spill!.suffix).toContain(`task_id: ${taskId}`);
    expect(spill!.suffix).toContain('output_size_bytes:');
    expect(spill!.suffix).toContain(`TaskOutput(task_id="${taskId}")`);
  });

  it('leaves the result for generic pipeline spill when task-log persistence is unavailable', async () => {
    const fullOutput = `${'short line\n'.repeat(6_000)}tail survives\n`;
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createTaskChannel({ outputPersistenceAvailable: false });
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    expect(result.spill).toEqual({ suffix: 'Command executed successfully.' });
    expect(persisted.size).toBe(0);
  });

  it('leaves the result untouched at exactly the delivery cap boundary', async () => {
    const fullOutput = 'x'.repeat(50_000);
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'edge', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    expect(result.spill).toBeUndefined();
    expect(persisted.size).toBe(0);
  });

  it('reuses the persisted task log even when output exceeds the retention budget', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const { service, handlers } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    const taskId = /\/tasks\/(bash-[0-9a-z]{8})\/output\.log$/.exec(
      result.spill!.outputPath!,
    )?.[1];
    expect(taskId).toBeTruthy();
    expect(handlers.get(taskId!)?.output().path).toBe(result.spill!.outputPath);
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('carries the failure message in the spill suffix when retention capped the output', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge, exitCode: 1 }));
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(result.spill?.suffix).toContain('Command failed with exit code: 1.');
  });

  it('omits the TaskOutput hint from the spill suffix when background tools are disabled', async () => {
    const fullOutput = 'short line\n'.repeat(6_000);
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.spill?.outputPath).toContain('/tasks/');
    expect(result.spill?.suffix).toContain('task_id:');
    expect(result.spill?.suffix).not.toContain('TaskOutput');
  });

  it('rejects empty-string commands at the schema layer', () => {
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
  });

  it('does not inject GIT_SSH_COMMAND into the spawn environment', async () => {
    const previous = process.env['GIT_SSH_COMMAND'];
    delete process.env['GIT_SSH_COMMAND'];
    try {
      const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'ok\n' }));
      const tool = bashTool(runner);

      await executeTool(tool, context({ command: 'true', timeout: 60 }));

      const env = exec.mock.calls[0]?.[2]?.env as Record<string, string>;
      expect(Object.prototype.hasOwnProperty.call(env, 'GIT_SSH_COMMAND')).toBe(false);
    } finally {
      if (previous !== undefined) process.env['GIT_SSH_COMMAND'] = previous;
    }
  });

  it('rewrites nul-redirect on Windows so the spawned argv has /dev/null', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const args = exec.mock.calls[0]?.[1] as readonly string[];
    expect(args[1]).toBe("cd '/c/Users/me/project' && ls 2>/dev/null");
  });

  it('passes nul-redirect through unchanged on Linux so the argv keeps the literal file target', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const args = exec.mock.calls[0]?.[1] as readonly string[];
    expect(args[1]).toBe("cd '/workspace' && ls 2>nul");
  });

  it('disables background execution when TaskList is inactive even if TaskOutput/TaskStop are active', async () => {
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createTaskChannel().service,
      stubToolPolicy((name) => name !== 'TaskList'),
    );

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolves the detach timeout from the bashTaskTimeoutS config', async () => {
    async function detachTimeoutMsFor(
      configValues: Record<string, unknown>,
    ): Promise<number | undefined> {
      const { runner } = createTestRunner(processWithOutput());
      const { service, tasks } = createTaskChannel();
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        service,
        stubToolPolicy(),
        stubConfig(configValues),
      );

      const result = await executeTool(
        tool,
        context({ command: 'watch', run_in_background: true, description: 'watch files' }),
      );
      expect(result).toMatchObject({ isError: false });

      const taskId = service.list(false)[0]!.taskId;
      const fields = tasks.get(taskId)?.snapshot().fields as {
        readonly task?: { readonly timeoutMs?: number };
      } | undefined;
      return fields?.task?.timeoutMs;
    }

    await expect(detachTimeoutMsFor({})).resolves.toBe(600_000);
    await expect(detachTimeoutMsFor({ task: { bashTaskTimeoutS: 30 } })).resolves.toBe(30_000);
    await expect(detachTimeoutMsFor({ background: { bashTaskTimeoutS: 45 } })).resolves.toBe(
      45_000,
    );
    await expect(detachTimeoutMsFor({ task: { bashTaskTimeoutS: 0 } })).resolves.toBe(0);
  });
});

describe('BashTool display cwd', () => {
  function environmentService(environment: FakeEnvironment): IAgentEnvironmentService {
    return stubAgentEnvironment(environment, { workDir: '' });
  }

  function displayCwdTool(environment: IAgentEnvironmentService, ctx: ISessionContext, workDir: string): BashTool {
    return new BashTool(
      environment,
      ctx,
      stubWorkspaceContext(workDir),
      createTaskChannel().toolExecutor,
      {} as never,
      {} as unknown as IAgentToolPolicyService,
      {} as unknown as IConfigService,
    );
  }

  async function displayCwd(tool: BashTool, args: BashInput): Promise<string | undefined> {
    const resolved: ToolExecution = await Promise.resolve(tool.resolveExecution(args));
    if (resolved.isError === true) return undefined;
    const display = resolved.display;
    return display?.kind === 'command' ? display.cwd : undefined;
  }

  it('resolves a relative cwd argument against the binding cwd on the bound environment', async () => {
    const environment = new FakeEnvironment({ environmentId: 'dev-box', generation: 'g' });
    const tool = displayCwdTool(environmentService(environment), createTestCtx('/Users/mac/project'), '/home/deploy/app');

    await expect(displayCwd(tool, { command: 'ls', cwd: 'src/lib' })).resolves.toBe(
      '/home/deploy/app/src/lib',
    );
  });
});

describe('BashTool spawn cwd', () => {
  function spawnCwdBackend(runner: IHostProcessService): FakeEnvironment {
    const processService: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args = [], options) => runner.spawn(command, args, options),
    };
    return Object.assign(
      new FakeEnvironment(
        { environmentId: 'dev-box', generation: 'g' },
        { capabilities: ['process'], pathClass: 'posix' },
      ),
      { host: createTestEnv(), process: processService },
    );
  }

  function spawnCwdTool(backend: FakeEnvironment, workDir: string): BashTool {
    const channel = createTaskChannel();
    const tool = new BashTool(
      stubAgentEnvironment(backend),
      createTestCtx('/Users/mac/project'),
      stubWorkspaceContext(workDir),
      channel.toolExecutor,
      channel.outputs,
      stubToolPolicy(),
      stubConfig(),
    );
    channel.raw.addExecute(new LegacyExecutableToolAdapter(tool));
    channelsByTool.set(tool, channel);
    return tool;
  }

  it('spawns each session command with its own workDir on a shared environment', async () => {
    const { runner, exec } = createTestRunner(processWithOutput());
    const backend = spawnCwdBackend(runner);

    await executeTool(spawnCwdTool(backend, '/remote/a'), context({ command: 'ls', timeout: 60 }));
    await executeTool(spawnCwdTool(backend, '/remote/b'), context({ command: 'ls', cwd: 'src', timeout: 60 }));

    expect(exec.mock.calls.map((call) => call[2]?.cwd)).toEqual(['/remote/a', '/remote/b/src']);
  });
});

describe('BashTool background mode', () => {
  it('can detach a foreground command through the background service', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });
    (proc.stdout as PassThrough).write('before detach\n');

    expect(task).toMatchObject({
      kind: 'process',
      detached: false,
      command: 'sleep 10',
    });

    service.detach(task.taskId);
    const result = await running;
    (proc.stdout as PassThrough).write('after detach\n');

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('before detach\n');
    expect(result.output).not.toContain('after detach\n');
    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('The user moved this task to the background.');
    expect(result.output).toContain('detached_by_user: true');
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput');
    expect(result.output).toContain('human_shell_hint: The task is visible in the background-task panel.');
    expect((result as { brief?: string }).brief).toBe(`Backgrounded ${task.taskId} by the user`);
    expect(service.getTask(task.taskId)).toMatchObject({ detached: true });
    await vi.waitFor(async () => {
      await expect(service.readOutput(task.taskId)).resolves.toContain('after detach\n');
    });

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('notifies when a foreground command registers its background task', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const started = vi.fn();

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }, undefined, started));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    expect(started).toHaveBeenCalledWith(task.taskId);

    finish();
    await running;
  });

  it('records the parent tool call id on the registered task', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'process',
      detached: false,
      parentToolCallId: 'call_bash',
    });

    finish();
    await running;
  });

  it('applies the background timeout when a foreground command is detached', async () => {
    vi.useFakeTimers();
    try {
      const { proc } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createTaskChannel();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 10', timeout: 1 }));
      await vi.waitFor(() => {
        expect(service.list(false)).toHaveLength(1);
      });
      const task = service.list(false)[0]!;

      service.detach(task.taskId);
      await running;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.getTask(task.taskId)?.status).toBe('running');

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(service.getTask(task.taskId)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a timed-out foreground command to the background instead of killing it', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finish } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createTaskChannel();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 30', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
        brief: expect.stringContaining('after timeout'),
      });
      expect(result.output).toContain('The task now runs in the background.');
      expect(result.output).not.toContain('The user moved this task');
      expect(result.output).not.toContain('detached_by_user');
      expect(result.output).toContain('human_shell_hint: The task is visible in the background-task panel.');
      const taskId = /^task_id: (\S+)/m.exec(result.output as string)?.[1];
      expect(taskId).toBeDefined();
      expect(service.getTask(taskId!)).toMatchObject({ status: 'running', detached: true });

      (proc.stdout as PassThrough).write('after timeout\n');
      finish(0);
      const completed = service.wait(taskId!);
      await vi.advanceTimersByTimeAsync(250);
      await expect(completed).resolves.toMatchObject({ status: 'completed' });
      await expect(service.readOutput(taskId!)).resolves.toContain('after timeout\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recommend disabled task tools when a foreground command is detached', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    service.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('You will be automatically notified when it completes');
    expect(result.output).toContain('do NOT wait or poll');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps task metadata independent when noisy foreground output is detached', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'yes noisy', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });

    (proc.stdout as PassThrough).write(
      Array.from({ length: 6000 }, (_, index) => `noisy output line ${String(index)}\n`).join(''),
    );
    service.detach(task.taskId);
    const result = await running;

    expect(result).toMatchObject({ isError: false });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain(`task_id: ${task.taskId}`);
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('foreground_output:');
    expect(output).toContain('noisy output line 0');
    expect(output).toContain('noisy output line 5999');
    expect(output).not.toContain('[...truncated]');
    expect(output.indexOf(`task_id: ${task.taskId}`)).toBeLessThan(
      output.indexOf('foreground_output:'),
    );

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('requires background tools to be enabled and description for background commands', async () => {
    const proc = processWithOutput();
    const { runner, exec } = createTestRunner(proc);
    const backgroundDisabled = bashTool(
      runner,
      createTestEnv(), createTestCtx(),
      createTaskChannel().service,
      stubToolPolicy(() => false),
    );

    const unavailable = await executeTool(
      backgroundDisabled,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();

    const { service } = createTaskChannel();
    const withService = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const missingDescription = await executeTool(
      withService,
      context({ command: 'sleep 10', run_in_background: true }),
    );

    expect(missingDescription).toMatchObject({ isError: true });
    expect(missingDescription.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });

  it('registers background commands and returns a task id', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'long running task' }),
    );

    expect(result.output).toMatch(/task_id: bash-[0-9a-z]{8}/);
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(result.output).not.toContain('block=false');
    expect(service.list(false)).toHaveLength(1);
  });

  it('allows multiple background commands without imposing a task limit', async () => {
    const { service } = createTaskChannel();
    const firstProc = processWithOutput();
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const results = await Promise.all([
      executeTool(tool, context({ command: 'sleep 10', run_in_background: true, description: 'first task' })),
      executeTool(tool, context({ command: 'sleep 10', run_in_background: true, description: 'second task' })),
    ]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: false }),
    ]);
    expect(secondProc.kill).not.toHaveBeenCalledWith('SIGTERM');
    expect(service.list(false)).toHaveLength(2);
  });

  it('allows concurrent background commands without rejecting either', async () => {
    const { service } = createTaskChannel();
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const results = await Promise.all([
      executeTool(tool, context({ command: 'sleep 10', run_in_background: true, description: 'first task' })),
      executeTool(tool, context({ command: 'sleep 10', run_in_background: true, description: 'second task' })),
    ]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(secondProc.kill).not.toHaveBeenCalledWith('SIGTERM');
    expect(results).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: false }),
    ]);
    expect(service.list(false)).toHaveLength(2);
  });

  it('uses Git Bash semantics without imposing a task limit', async () => {
    const { service } = createTaskChannel();
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'), service);

    const results = await Promise.all([
      executeTool(tool, context({
        command: 'echo ok 2>nul',
        run_in_background: true,
        description: 'first task',
      })),
      executeTool(tool, context({
        command: 'echo second',
        run_in_background: true,
        description: 'second task',
      })),
    ]);

    expect(exec).toHaveBeenCalledTimes(2);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(args).toEqual(['-c', "cd '/c/Users/me/project' && echo ok 2>/dev/null"]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(secondProc.kill).not.toHaveBeenCalledWith('SIGTERM');
    expect(results).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: false }),
    ]);
    expect(service.list(false)).toHaveLength(2);
  });

  it('timeout-stops a background task that has not settled even if process exit is visible', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finishWait, markExited } = processWithVisibleExitBeforeWait(0);
      const { runner } = createTestRunner(proc);
      const { service } = createTaskChannel();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
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

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      finishWait();
      await vi.runAllTimersAsync();

      expect(service.getTask(taskId!)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout-stops a background task after the default 10 minute deadline', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const { runner } = createTestRunner(proc);
      const { service } = createTaskChannel();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
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
      const { runner } = createTestRunner(proc);
      const { service } = createTaskChannel();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
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

  it('reports background task startup with task_id, status, automatic_notification, and a human-shell hint', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createTaskChannel();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true, description: 'sleep task' }),
    );

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('task_id:');
    expect(output).toContain('status: running');
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(output).not.toContain('block=false');
    expect(output).toContain('human_shell_hint: The task is visible in the background-task panel.');
    expect(output).not.toContain('/tasks');
  });

  it('rejects background command without description (description-required guard)', async () => {
    const { service } = createTaskChannel();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('BashTool prompt / environment consistency', () => {
  it('reports unavailable background using only tools the prompt documents', async () => {
    const { runner } = createTestRunner(processWithOutput());

    const enabledTool = bashTool(runner);
    const promptToolNames = new Set(
      [...enabledTool.description.matchAll(/`(Task[A-Za-z]+)`/g)].map((match) => match[1]),
    );

    const tool = bashTool(runner, createTestEnv(), createTestCtx(), createTaskChannel().service, stubToolPolicy(() => false));
    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const errorToolNames = [...(result.output as string).matchAll(/\b(Task[A-Za-z]+)\b/g)].map(
      (match) => match[1],
    );

    for (const name of errorToolNames) {
      expect(promptToolNames).toContain(name);
    }
    expect(errorToolNames.length).toBeGreaterThan(0);
  });
});
