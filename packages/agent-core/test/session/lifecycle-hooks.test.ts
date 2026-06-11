import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';

import { testKaos } from '../fixtures/test-kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { AgentBackgroundTask, ProcessBackgroundTask } from '../../src/agent/background';


const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('Session lifecycle hooks', () => {
  it('fires SessionStart on startup and SessionEnd on close', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-123',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [
        { event: 'SessionStart', matcher: 'startup', command, timeout: 5 },
        { event: 'SessionEnd', matcher: 'exit', command, timeout: 5 },
      ],
    });

    await session.createMain();
    await session.close();

    expect(await readHookPayloads(logPath)).toMatchObject([
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-123',
        cwd: workDir,
        source: 'startup',
      },
      {
        hook_event_name: 'SessionEnd',
        session_id: 'session-123',
        cwd: workDir,
        reason: 'exit',
      },
    ]);
  });

  it('fires SessionStart with resume source after loading metadata', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        title: 'Resumed Session',
        isCustomTitle: false,
        agents: {},
        custom: {},
      }),
      'utf-8',
    );
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-456',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [{ event: 'SessionStart', matcher: 'resume', command, timeout: 5 }],
    });

    await session.resume();

    expect(await readHookPayloads(logPath)).toMatchObject([
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-456',
        cwd: workDir,
        source: 'resume',
      },
    ]);
  });

  it('does not let failing SessionStart or SessionEnd hook commands interrupt startup or close', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-reject',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [
        { event: 'SessionStart', matcher: 'startup', command: 'exit 1', timeout: 5 },
        { event: 'SessionEnd', matcher: 'exit', command: 'exit 1', timeout: 5 },
      ],
    });

    await expect(session.createMain()).resolves.toBeDefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('stops background tasks on close by default', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-bg-cleanup',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'exit cleanup'),
    );

    await session.close();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
  });

  it('keeps background tasks alive on close when keepAliveOnExit is true', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-bg-keepalive',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'keep alive'),
    );

    await session.close();

    expect(killSpy).not.toHaveBeenCalled();
    expect(agent.background.getTask(taskId)?.status).toBe('running');
  });

  it('keeps background agent turns alive on close when keepAliveOnExit is true', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-bg-agent-keepalive',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const main = await session.createMain();
    const { id: childId, agent: child } = await session.createAgent(
      { type: 'sub' },
      { parentAgentId: 'main' },
    );
    const turnSettled = createDeferred<void>();
    const waitSpy = vi
      .spyOn(child.turn, 'waitForCurrentTurn')
      .mockImplementation(() => turnSettled.promise as never);
    const cancelSpy = vi.spyOn(child.turn, 'cancel').mockImplementation(() => {
      turnSettled.resolve();
    });
    vi.spyOn(child.turn, 'hasActiveTurn', 'get').mockReturnValue(true);
    const abort = vi.fn();
    const taskId = main.background.registerTask(
      new AgentBackgroundTask(new Promise(() => {}), 'keep background agent alive', {
        abort,
        agentId: childId,
        subagentType: 'coder',
      }),
    );

    await session.close();

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(waitSpy).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(main.background.getTask(taskId)?.status).toBe('running');
  });

  it('lets the environment override config when deciding background task cleanup', async () => {
    vi.stubEnv('KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT', '0');
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-bg-env-cleanup',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'env cleanup'),
    );

    await session.close();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
  });

  it('cancels an active foreground turn before closing', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-active-turn-cleanup',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    const turnSettled = createDeferred<void>();
    const waitSpy = vi
      .spyOn(agent.turn, 'waitForCurrentTurn')
      .mockImplementation(() => turnSettled.promise as never);
    const cancelSpy = vi.spyOn(agent.turn, 'cancel').mockImplementation(() => {
      turnSettled.resolve();
    });
    vi.spyOn(agent.turn, 'hasActiveTurn', 'get').mockReturnValue(true);

    await session.close();

    expect(cancelSpy).toHaveBeenCalledWith(undefined, expect.any(Error));
    expect(waitSpy).toHaveBeenCalledOnce();
  });

  it('records session-close cancellation during UserPromptSubmit hooks as cancelled', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const hookStartedPath = join(workDir, 'hook-started');
    const hookScriptPath = join(workDir, 'blocking-user-prompt-hook.cjs');
    await writeFile(
      hookScriptPath,
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.argv[2], 'started');",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      'utf-8',
    );
    const emitEvent = vi.fn<SDKSessionRPC['emitEvent']>(async () => {});
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-close-during-user-hook',
      homedir: sessionDir,
      rpc: createSessionRpc({ emitEvent }),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [
        {
          event: 'UserPromptSubmit',
          command: `node ${JSON.stringify(hookScriptPath)} ${JSON.stringify(hookStartedPath)}`,
          timeout: 30,
        },
      ],
    });
    const agent = await session.createMain();

    agent.turn.prompt([{ type: 'text', text: 'run the hook' }]);
    await waitForFile(hookStartedPath);
    await session.close();

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'cancelled',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'failed',
      }),
    );
  });

  it('keeps background tasks alive and skips SessionEnd hooks when closing for reload', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-reload-close',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: false },
      hooks: [
        { event: 'SessionStart', matcher: 'startup', command, timeout: 5 },
        { event: 'SessionEnd', matcher: 'exit', command, timeout: 5 },
      ],
    });
    const agent = await session.createMain();
    const stopSpy = vi.spyOn(agent.cron!, 'stop');
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'reload keeps alive'),
    );

    await session.closeForReload();

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(killSpy).not.toHaveBeenCalled();
    expect(agent.background.getTask(taskId)?.status).toBe('running');
    expect(await readHookPayloads(logPath)).toMatchObject([
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-reload-close',
        cwd: workDir,
        source: 'startup',
      },
    ]);
  });
});

async function hookFixture(): Promise<{
  readonly command: string;
  readonly logPath: string;
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await makeTempDir();
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  const logPath = join(dir, 'hooks.jsonl');
  const scriptPath = join(dir, 'record-hook.cjs');
  await mkdir(join(workDir, '.git'), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    scriptPath,
    [
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { appendFileSync(process.argv[2], `${input.trim()}\\n`); });",
      '',
    ].join('\n'),
    'utf-8',
  );
  return {
    command: `node ${JSON.stringify(scriptPath)} ${JSON.stringify(logPath)}`,
    logPath,
    sessionDir,
    workDir,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-session-hooks-'));
  tempDirs.push(dir);
  return dir;
}

async function readHookPayloads(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, 'utf-8');
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createSessionRpc(overrides: Partial<SDKSessionRPC> = {}): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
    ...overrides,
  } as SDKSessionRPC;
}

async function waitForFile(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(path, 'utf-8');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: (value: T) => void = () => {
    /* replaced below */
  };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: resolveValue,
  };
}

function pendingProcess(exitOnKill = 143): {
  readonly proc: KaosProcess;
  readonly killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = exitOnKill;
    resolveWait(exitOnKill);
  });
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54_321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
  };
  return { proc, killSpy };
}
