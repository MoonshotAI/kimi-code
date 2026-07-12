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
import { ProcessBackgroundTask } from '../../src/agent/background';
import { agentTask } from '../agent/background/helpers';


const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('does not steer background task notifications while closing the session', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-bg-cleanup-no-steer',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    const steerSpy = vi.spyOn(agent.turn, 'steer');
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'exit cleanup without steer'),
    );

    await session.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
    expect(steerSpy).not.toHaveBeenCalled();
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
    const abortController = new AbortController();
    const abort = vi.spyOn(abortController, 'abort');
    const taskId = main.background.registerTask(
      agentTask(new Promise(() => {}), 'keep background agent alive', {
        abortController,
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

  it('waitForBackgroundTasksOnPrint returns immediately when keepAliveOnExit is false', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-wait-disabled',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: false },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'no wait'),
    );

    await session.waitForBackgroundTasksOnPrint();

    expect(killSpy).not.toHaveBeenCalled();
    expect(agent.background.getTask(taskId)?.status).toBe('running');
    await session.close();
  });

  it('waitForBackgroundTasksOnPrint waits for background tasks to finish when keepAliveOnExit is true', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-wait',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const { proc } = pendingProcess(0);
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'wait for me'),
    );

    let settled = false;
    const waitPromise = session.waitForBackgroundTasksOnPrint().then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await proc.kill('SIGTERM');
    await waitPromise;
    expect(settled).toBe(true);
    expect(agent.background.getTask(taskId)?.status).toBe('completed');
    await session.close();
  });

  it('waitForBackgroundTasksOnPrint times out after printWaitCeilingS', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-wait-timeout',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true, printWaitCeilingS: 1 },
    });
    const agent = await session.createMain();
    const { proc } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'times out'),
    );

    await session.waitForBackgroundTasksOnPrint();

    expect(agent.background.getTask(taskId)?.status).toBe('running');
    await session.close();
  });

  it('handlePrintMainTurnCompleted returns finish by default (exit mode)', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-mode-exit',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await session.createMain();

    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('finish');
    await session.close();
  });

  it('handlePrintMainTurnCompleted drains when printBackgroundMode is drain without keepAliveOnExit', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-mode-drain',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { printBackgroundMode: 'drain' },
    });
    const agent = await session.createMain();
    const { proc } = pendingProcess(0);
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'drain me'),
    );

    let settled = false;
    const promise = session.handlePrintMainTurnCompleted().then((action) => {
      settled = true;
      return action;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await proc.kill('SIGTERM');
    await expect(promise).resolves.toBe('finish');
    expect(agent.background.getTask(taskId)?.status).toBe('completed');
    await session.close();
  });

  it('explicit printBackgroundMode exit overrides keepAliveOnExit (no drain)', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-mode-exit-override',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true, printBackgroundMode: 'exit' },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 60', 'no drain'),
    );

    await session.waitForBackgroundTasksOnPrint();
    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('finish');

    expect(killSpy).not.toHaveBeenCalled();
    expect(agent.background.getTask(taskId)?.status).toBe('running');
    await proc.kill('SIGTERM').catch(() => undefined);
    await session.close();
  });

  it('handlePrintMainTurnCompleted returns continue in steer mode while a task is pending, then finish once quiescent', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-mode-steer',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { printBackgroundMode: 'steer' },
    });
    const agent = await session.createMain();
    const { proc } = pendingProcess();
    agent.background.registerTask(new ProcessBackgroundTask(proc, 'sleep 60', 'steer me'));

    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('continue');

    await proc.kill('SIGTERM');
    // Let the background manager observe the terminal status.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('finish');
    await session.close();
  });

  it('handlePrintMainTurnCompleted finishes in steer mode once printMaxTurns is reached', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-mode-steer-cap',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { printBackgroundMode: 'steer', printMaxTurns: 1 },
    });
    const agent = await session.createMain();
    const { proc } = pendingProcess();
    agent.background.registerTask(new ProcessBackgroundTask(proc, 'sleep 60', 'cap me'));

    // First call: printSteerTurns becomes 1 (not over cap), task pending ⇒ continue.
    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('continue');
    // Second call: printSteerTurns becomes 2 (> printMaxTurns=1) ⇒ finish even though
    // the task is still running.
    await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('finish');

    await proc.kill('SIGTERM').catch(() => undefined);
    await session.close();
  });

  it('waitForBackgroundTasksOnPrint waits for tasks spawned after the first enumeration', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-wait-fanout',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const first = pendingProcess(0);
    const firstTaskId = agent.background.registerTask(
      new ProcessBackgroundTask(first.proc, 'sleep 60', 'first'),
    );

    let settled = false;
    const waitPromise = session.waitForBackgroundTasksOnPrint().then(() => {
      settled = true;
    });

    // Let the first enumeration run and suspend on the first task.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    // Fan out a second background task after the first enumeration.
    const second = pendingProcess(0);
    const secondTaskId = agent.background.registerTask(
      new ProcessBackgroundTask(second.proc, 'sleep 60', 'second'),
    );

    // Finish the first task; the wait must not settle while the second is running.
    await first.proc.kill('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    // Finish the second task; the wait should now settle.
    await second.proc.kill('SIGTERM');
    await waitPromise;
    expect(settled).toBe(true);
    expect(agent.background.getTask(firstTaskId)?.status).toBe('completed');
    expect(agent.background.getTask(secondTaskId)?.status).toBe('completed');
    await session.close();
  });

  it('suppresses notifications for every active task before awaiting any of them', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-wait-suppress-race',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const steerSpy = vi.spyOn(agent.turn, 'steer');

    // Detached tasks fire a completion notification unless suppressed.
    const first = pendingProcess(0);
    agent.background.registerTask(new ProcessBackgroundTask(first.proc, 'sleep 60', 'first'), {
      detached: true,
    });
    const second = pendingProcess(0);
    agent.background.registerTask(
      new ProcessBackgroundTask(second.proc, 'sleep 60', 'second'),
      { detached: true },
    );

    const waitPromise = session.waitForBackgroundTasksOnPrint();

    // Let the synchronous enumeration run so both tasks get suppressed.
    await new Promise((resolve) => setImmediate(resolve));

    // Complete both tasks after suppression but before the wait settles.
    await first.proc.kill('SIGTERM');
    await second.proc.kill('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(steerSpy).not.toHaveBeenCalled();
    await waitPromise;
    await session.close();
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

  it('createMain enables print drain when drainAgentTasksOnStop is true', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-drain',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true, printWaitCeilingS: 42 },
      drainAgentTasksOnStop: true,
    });
    const agent = await session.createMain();

    expect(agent.printDrainAgentTasksOnStop).toBe(true);
    await session.close();
  });

  it('createMain leaves print drain disabled by default', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-print-drain-off',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();

    expect(agent.printDrainAgentTasksOnStop).toBe(false);
    await session.close();
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
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
  return { proc, killSpy };
}
