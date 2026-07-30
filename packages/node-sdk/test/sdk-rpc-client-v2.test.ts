/**
 * Scenario: v2 wiring MVP — the harness talks to the in-process agent-core-v2
 * engine (klient memory transport) instead of the v1 KimiCore RPC pair.
 * Responsibilities: `getExperimentalFeatures` is migrated end-to-end; every
 * not-yet-migrated method fails loudly with `not_implemented` instead of
 * silently hitting a v1 core.
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/sdk-rpc-client-v2.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IAgentLifecycleService,
  IEventBus,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
  type DomainEvent,
} from '@moonshot-ai/agent-core-v2';

import { createKimiHarnessV2, ErrorCodes, KimiError, KimiHarness, SDKRpcClientV2 } from '#/index';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import { IHostRequestHeaders } from '@moonshot-ai/agent-core-v2';

import { TEST_IDENTITY } from './test-identity';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<{ harness: KimiHarness; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
  tempDirs.push(homeDir);
  return { harness: createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY }), homeDir };
}

describe('SDKRpcClientV2 (agent-core-v2 wiring MVP)', () => {
  it('seeds the host request headers (User-Agent + X-Msh-*) into the engine', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      // Without this seed the managed vendors go out with the SDK's default
      // User-Agent and no X-Msh-* — the interactive-v2 path's identity bug.
      const headers = client.engineAccessor.get(IHostRequestHeaders).headers;
      expect(headers['User-Agent']).toBe(`kimi-code-cli/${TEST_IDENTITY.version}`);
      expect(headers['X-Msh-Platform']).toBe('kimi_code_cli');
      expect(headers['X-Msh-Version']).toBe(TEST_IDENTITY.version);
      expect(headers['X-Msh-Device-Id']).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('serves getExperimentalFeatures from the v2 engine', async () => {
    const { harness } = await makeHarness();
    try {
      const features = await harness.getExperimentalFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features) {
        expect(typeof feature.id).toBe('string');
        expect(typeof feature.title).toBe('string');
        expect(typeof feature.env).toBe('string');
        expect(typeof feature.enabled).toBe('boolean');
        expect(typeof feature.defaultEnabled).toBe('boolean');
      }
    } finally {
      await harness.close();
    }
  });

  it('serves listWorkspaceSkills through the engineAccessor escape hatch', async () => {
    const { harness, homeDir } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-user-skill')).toMatchObject({
        description: 'Skill demo-user-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.get('demo-project-skill')).toMatchObject({
        description: 'Skill demo-project-skill for the escape-hatch test',
        source: 'project',
      });
    } finally {
      await harness.close();
    }
  });

  it('honors skillDirs (explicit dirs) over default user / project discovery', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const explicitBase = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-explicit-'));
    tempDirs.push(explicitBase);
    const explicitDir = join(explicitBase, 'skills');
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    await writeSkill(join(explicitDir, 'demo-explicit-skill'), 'demo-explicit-skill');
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      skillDirs: [explicitDir],
    });
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-explicit-skill')).toMatchObject({
        description: 'Skill demo-explicit-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.has('demo-user-skill')).toBe(false);
      expect(byName.has('demo-project-skill')).toBe(false);

      // The session skill catalog (the Skill tool's listing) goes through the
      // seeded engine runtime options, so it sees the same explicit source.
      const session = await harness.createSession({ workDir });
      const sessionNames = new Set((await session.listSkills()).map((skill) => skill.name));
      expect(sessionNames.has('demo-explicit-skill')).toBe(true);
      expect(sessionNames.has('demo-user-skill')).toBe(false);
      expect(sessionNames.has('demo-project-skill')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('serves the plugin catalog from the v2 engine on an empty home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      expect(await rpc.listPlugins()).toEqual([]);
      expect(await rpc.reloadPlugins()).toEqual({ added: [], removed: [], errors: [] });
      await expect(rpc.getPluginInfo('missing-plugin')).rejects.toThrow();
    } finally {
      await rpc.close();
    }
  });

  it('wires session events before downstream creation hooks can emit', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_resume_hook_event';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let signalEventPublished!: () => void;
    const eventPublished = new Promise<void>((resolve) => {
      signalEventPublished = resolve;
    });
    const events: Array<{ readonly type: string; readonly sessionId?: string }> = [];
    const unsubscribe = rpc.onEvent((event) => {
      events.push(event);
    });
    let resumeSettled = false;
    let resume: Promise<unknown> | undefined;
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    const hook = lifecycle.hooks.onDidCreateSession.register(
      'test-resume-hook-event',
      async (event, next) => {
        if (event.source === 'resume' && event.sessionId === sessionId) {
          const agentLifecycle = event.handle.accessor.get(IAgentLifecycleService);
          const onDidCreate = agentLifecycle.onDidCreate((main) => {
            if (main.id !== MAIN_AGENT_ID) return;
            main.accessor.get(IEventBus).publish({
              type: 'assistant.delta',
              turnId: 1,
              delta: 'Published before resume returned.',
            } as DomainEvent);
            signalEventPublished();
          });
          try {
            // The terminal materializes the main agent. SessionEventWiring's
            // earlier onDidCreate listener must attach its event bus before
            // this callback publishes, and the outer hook stays pending so
            // the assertion runs before resume can settle.
            await next();
            await hookGate;
          } finally {
            onDidCreate.dispose();
          }
          return;
        }
        await next();
      },
    );

    try {
      await rpc.createSession({ id: sessionId, workDir });
      await rpc.closeSession({ sessionId });
      events.length = 0;

      resume = rpc.resumeSession({ id: sessionId }).finally(() => {
        resumeSettled = true;
      });
      await eventPublished;

      expect(resumeSettled).toBe(false);
      expect(events).toContainEqual({
        type: 'assistant.delta',
        sessionId,
        agentId: MAIN_AGENT_ID,
        turnId: 1,
        delta: 'Published before resume returned.',
      });
    } finally {
      releaseHook();
      await resume?.catch(() => undefined);
      hook.dispose();
      unsubscribe();
      await rpc.close();
    }
  });

  it('drops provisional event wiring when a downstream creation hook fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_resume_hook_failure';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    const startupError = new Error('downstream startup failed');
    let rejectNextResume = true;
    const hook = lifecycle.hooks.onDidCreateSession.register(
      'test-resume-hook-failure',
      async (event, next) => {
        if (
          event.source === 'resume' &&
          event.sessionId === sessionId &&
          rejectNextResume
        ) {
          rejectNextResume = false;
          throw startupError;
        }
        await next();
      },
    );
    const events: Array<{ readonly type: string; readonly sessionId?: string }> = [];
    const unsubscribe = rpc.onEvent((event) => {
      events.push(event);
    });

    try {
      await rpc.createSession({ id: sessionId, workDir });
      await rpc.closeSession({ sessionId });
      events.length = 0;

      await expect(rpc.resumeSession({ id: sessionId })).rejects.toBe(startupError);
      expect(lifecycle.get(sessionId)).toBeUndefined();

      await rpc.resumeSession({ id: sessionId });
      const resumed = lifecycle.get(sessionId);
      if (resumed === undefined) throw new Error('session was not resumed');
      const main = resumed.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
      if (main === undefined) throw new Error('resumed session has no main agent');
      main.accessor.get(IEventBus).publish({
        type: 'assistant.delta',
        turnId: 2,
        delta: 'Published after retry.',
      } as DomainEvent);

      expect(
        events.filter((event) => event.type === 'assistant.delta'),
      ).toEqual([
        {
          type: 'assistant.delta',
          sessionId,
          agentId: MAIN_AGENT_ID,
          turnId: 2,
          delta: 'Published after retry.',
        },
      ]);
    } finally {
      hook.dispose();
      unsubscribe();
      await rpc.close();
    }
  });

  it('fails loudly with not_implemented for methods not yet migrated', async () => {
    const { harness } = await makeHarness();
    try {
      // `deleteSession` is the permanent case: the v2 engine has no
      // session-deletion capability, so it stays not_implemented by design
      // (tracked in `.tmp/v2-migration-tracker.md`).
      await expect(harness.deleteSession('session_missing')).rejects.toThrowError(KimiError);
      await expect(harness.deleteSession('session_missing')).rejects.toMatchObject({
        code: ErrorCodes.NOT_IMPLEMENTED,
      });
    } finally {
      await harness.close();
    }
  });
});

describe('foldAgentWireReplay', () => {
  it('folds a journal into v1 replay records and the tool store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const wirePath = join(dir, 'wire.jsonl');
    const records = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1000 },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission.set_mode', mode: 'auto', time: 1002 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'old', status: 'done' }],
        time: 1003,
      },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'new', status: 'pending' }],
        time: 1004,
      },
      // A v2-only op the v1 restore switch does not know: ignored.
      { type: 'profile.bind', profileName: 'agent', systemPrompt: 'x', thinkingEffort: 'off', disallowedTools: [], time: 1005 },
    ];
    await writeFile(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
    const folded = await foldAgentWireReplay(wirePath);
    expect(folded.replay).toEqual([
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission_updated', mode: 'auto', time: 1002 },
    ]);
    // Last write wins per store key.
    expect(folded.toolStore).toEqual({ todo: [{ title: 'new', status: 'pending' }] });
  });

  it('degrades to an empty fold on a missing or corrupt journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const empty = { replay: [], toolStore: {} };
    await expect(foldAgentWireReplay(join(dir, 'missing.jsonl'))).resolves.toEqual(empty);
    const emptyFile = join(dir, 'empty.jsonl');
    await writeFile(emptyFile, '', 'utf-8');
    await expect(foldAgentWireReplay(emptyFile)).resolves.toEqual(empty);
    const corrupt = join(dir, 'corrupt.jsonl');
    await writeFile(
      corrupt,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{not json\n{"type":"permission.set_mode","mode":"auto"}\n',
      'utf-8',
    );
    await expect(foldAgentWireReplay(corrupt)).resolves.toEqual(empty);
    // A truncated TAIL line is tolerated: everything before it still folds.
    const truncatedTail = join(dir, 'truncated.jsonl');
    await writeFile(
      truncatedTail,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{"type":"permission.set_mode","mode":"auto","time":2}\n{"type":"context.append_messa',
      'utf-8',
    );
    const folded = await foldAgentWireReplay(truncatedTail);
    expect(folded.replay).toEqual([{ type: 'permission_updated', mode: 'auto', time: 2 }]);
  });
});

describe('SDKRpcClientV2 engine telemetry', () => {
  it('forwards engine-side events to the host-supplied telemetry client', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-work-'));
    tempDirs.push(workDir);
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(true);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('honors telemetry = false for engine-side events', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-work-'));
    tempDirs.push(workDir);
    await writeFile(join(homeDir, 'config.toml'), 'telemetry = false\n', 'utf-8');
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });
});

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name} for the escape-hatch test\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
}
