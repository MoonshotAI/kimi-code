import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { testKaos } from '../fixtures/test-kaos';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('SessionHost', () => {
  it('createMain registers the main agent in the host registry', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-create-main',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    const main = await session.createMain();

    expect(main.type).toBe('main');
    expect(session.host.agents.has('main')).toBe(true);
    expect(session.host.getReadyAgent('main')).toBe(main);
    // The Session.agents view delegates to the same host registry.
    expect(session.agents.has('main')).toBe(true);
    await session.close();
  });

  it('createAgent registers a subagent in the host map and metadata', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-create-agent',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await session.createMain();

    const { id, agent } = await session.createAgent(
      { type: 'sub' },
      { parentAgentId: 'main' },
    );

    expect(agent.type).toBe('sub');
    expect(session.host.agents.has(id)).toBe(true);
    expect(session.host.getReadyAgent(id)).toBe(agent);
    expect(session.metadata.agents[id]?.parentAgentId).toBe('main');
    await session.close();
  });

  it('close disposes every registered agent', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-close',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const main = await session.createMain();
    const { agent: child } = await session.createAgent(
      { type: 'sub' },
      { parentAgentId: 'main' },
    );
    const mainDispose = vi.spyOn(main, 'dispose');
    const childDispose = vi.spyOn(child, 'dispose');

    await session.close();

    expect(mainDispose).toHaveBeenCalledOnce();
    expect(childDispose).toHaveBeenCalledOnce();
  });

  it('resume restores the persisted main agent into the host registry', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const first = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-resume-first',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await first.createMain();
    await first.close();

    const resumed = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-resume-second',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await resumed.resume();

    expect(resumed.host.agents.has('main')).toBe(true);
    const main = resumed.host.getReadyAgent('main');
    expect(main).toBeDefined();
    expect(main?.type).toBe('main');
    await resumed.close();
  });

  it('fires session lifecycle hooks through the host on startup and close', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-hooks',
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
        session_id: 'host-hooks',
        source: 'startup',
      },
      {
        hook_event_name: 'SessionEnd',
        session_id: 'host-hooks',
        reason: 'exit',
      },
    ]);
  });

  it('fires session-scoped lifecycle hooks in willStart → didStart → willClose → didClose order', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-hook-order',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    const order: string[] = [];
    const disposables = [
      session.lifecycle.onSessionWillStart(() => {
        order.push('willStart');
      }),
      session.lifecycle.onSessionDidStart(() => {
        order.push('didStart');
      }),
      session.lifecycle.onSessionWillClose(() => {
        order.push('willClose');
      }),
      session.lifecycle.onSessionDidClose(() => {
        order.push('didClose');
      }),
    ];

    await session.createMain();
    await session.close();

    expect(order).toEqual(['willStart', 'didStart', 'willClose', 'didClose']);
    for (const d of disposables) d.dispose();
  });

  it('fires session-scoped lifecycle hooks in order during resume', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const first = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-hook-order-resume-first',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await first.createMain();
    await first.close();

    const resumed = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'host-hook-order-resume-second',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    const order: string[] = [];
    const disposables = [
      resumed.lifecycle.onSessionWillStart(() => {
        order.push('willStart');
      }),
      resumed.lifecycle.onSessionDidStart(() => {
        order.push('didStart');
      }),
      resumed.lifecycle.onSessionWillClose(() => {
        order.push('willClose');
      }),
      resumed.lifecycle.onSessionDidClose(() => {
        order.push('didClose');
      }),
    ];

    await resumed.resume();
    await resumed.close();

    expect(order).toEqual(['willStart', 'didStart', 'willClose', 'didClose']);
    for (const d of disposables) d.dispose();
  });
});

async function sessionFixture(): Promise<{
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-session-host-'));
  tempDirs.push(dir);
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  await mkdir(join(workDir, '.git'), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { sessionDir, workDir };
}

async function hookFixture(): Promise<{
  readonly command: string;
  readonly logPath: string;
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const { sessionDir, workDir } = await sessionFixture();
  const logPath = join(sessionDir, '..', 'hooks.jsonl');
  const scriptPath = join(sessionDir, '..', 'record-hook.cjs');
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
