/**
 * Scenario: v2 wiring MVP — the harness talks to the in-process agent-core-v2
 * engine (klient memory transport) instead of the v1 KimiCore RPC pair.
 * Responsibilities: migrated calls use the v2 engine, cold/active resume
 * handoffs gate agent producers, and not-yet-migrated methods fail loudly
 * instead of silently hitting a v1 core.
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/sdk-rpc-client-v2.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IAgentLifecycleService,
  IAgentLoopService,
  IEventBus,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
  type DomainEvent,
} from '@moonshot-ai/agent-core-v2';
import { MessageStepRequest } from '@moonshot-ai/agent-core-v2/agent/loop/stepRequest';

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

  it('keeps cold-resume producer admissions held through the handoff callback', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_resume_handoff_gate';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    let producerLoop: IAgentLoopService | undefined;
    let producer: ReturnType<IAgentLoopService['enqueue']> | undefined;
    let snapshotStarted = false;
    const hook = lifecycle.hooks.onDidCreateSession.register(
      'test-resume-handoff-producer',
      async (event, next) => {
        if (event.source !== 'resume' || event.sessionId !== sessionId) {
          await next();
          return;
        }
        const onDidCreate = event.handle.accessor
          .get(IAgentLifecycleService)
          .onDidCreate((agent) => {
            if (agent.id !== MAIN_AGENT_ID) return;
            expect(snapshotStarted).toBe(true);
            producerLoop = agent.accessor.get(IAgentLoopService);
            producer = producerLoop.enqueue(
              new MessageStepRequest(
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'Autonomous resume work.' }],
                  toolCalls: [],
                },
                { admission: 'newTurn', kind: 'test-resume-producer' },
              ),
            );
          });
        try {
          await next();
        } finally {
          onDidCreate.dispose();
        }
      },
    );

    try {
      await rpc.createSession({ id: sessionId, workDir });
      await rpc.closeSession({ sessionId });

      await rpc.resumeSessionWithHandoff(
        { id: sessionId },
        async (summary) => {
          expect(snapshotStarted).toBe(true);
          expect(summary.id).toBe(sessionId);
          expect(producerLoop?.status()).toMatchObject({
            state: 'idle',
            hasPendingRequests: true,
          });
          expect(producer?.abort()).toBe(true);
        },
        () => {
          expect(snapshotStarted).toBe(false);
          snapshotStarted = true;
        },
      );
    } finally {
      producer?.abort();
      hook.dispose();
      await rpc.close();
    }
  });

  it('keeps a successful direct cold handoff live when the next handoff rejects', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_direct_concurrent_handoff';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    const handoffError = new Error('direct v2 concurrent handoff rejected');

    try {
      await rpc.createSession({ id: sessionId, workDir });
      await rpc.closeSession({ sessionId });

      let successfulResume!: ReturnType<SDKRpcClientV2['resumeSessionWithHandoff']>;
      successfulResume = rpc.resumeSessionWithHandoff(
        { id: sessionId },
        async () => undefined,
      );
      const rejectedResume = rpc.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          await successfulResume;
          throw handoffError;
        },
      );
      void rejectedResume.catch(() => undefined);

      await expect(successfulResume).resolves.toMatchObject({ id: sessionId });
      await expect(rejectedResume).rejects.toBe(handoffError);
      expect(lifecycle.get(sessionId)).toBeDefined();

      await expect(
        rpc.resumeSessionWithHandoff(
          { id: ` ${sessionId} ` },
          async () => undefined,
        ),
      ).resolves.toMatchObject({ id: sessionId });
      expect(lifecycle.get(sessionId)).toBeDefined();
    } finally {
      await rpc.close();
    }
  });

  it('force-rolls back held producer work when the graceful cold-resume close fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_resume_handoff_failure';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    const handoffError = new Error('handoff failed');
    let loop: IAgentLoopService | undefined;
    let held: ReturnType<IAgentLoopService['enqueue']> | undefined;
    const started: number[] = [];
    let turnSubscription: { dispose(): void } | undefined;
    let failingCloseHook: { dispose(): void } | undefined;
    const hook = lifecycle.hooks.onDidCreateSession.register(
      'test-resume-handoff-failure',
      async (event, next) => {
        if (event.source === 'resume' && event.sessionId === sessionId) {
          const onDidCreate = event.handle.accessor
            .get(IAgentLifecycleService)
            .onDidCreate((agent) => {
              if (agent.id === MAIN_AGENT_ID) {
                loop = agent.accessor.get(IAgentLoopService);
                turnSubscription = agent.accessor
                  .get(IEventBus)
                  .subscribe('turn.started', (turn) => {
                    started.push(turn.turnId);
                  });
              }
            });
          try {
            await next();
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
      failingCloseHook = lifecycle.hooks.onWillCloseSession.register(
        'test-resume-handoff-close-failure',
        async (event, next) => {
          if (event.sessionId === sessionId) throw new Error('graceful close failed');
          await next();
        },
      );

      await expect(
        rpc.resumeSessionWithHandoff({ id: sessionId }, async () => {
          if (loop === undefined) throw new Error('resume did not materialize the main agent');
          held = loop.enqueue(
            new MessageStepRequest(
              {
                role: 'user',
                content: [{ type: 'text', text: 'Held until failed handoff.' }],
                toolCalls: [],
              },
              { admission: 'newTurn', kind: 'test-failed-handoff-producer' },
            ),
          );
          expect(loop.status()).toMatchObject({
            state: 'idle',
            hasPendingRequests: true,
          });
          throw handoffError;
        }),
      ).rejects.toBe(handoffError);

      if (loop === undefined) throw new Error('resume did not materialize the main agent');
      if (held === undefined) throw new Error('handoff did not enqueue producer work');
      const closedLoop = loop;
      await expect(held.assigned).rejects.toBeDefined();
      expect(closedLoop.status()).toMatchObject({
        state: 'idle',
        hasPendingRequests: false,
      });
      expect(started).toEqual([]);
      expect(rpc.engineAccessor.get(ISessionLifecycleService).get(sessionId)).toBeUndefined();
      expect(() =>
        closedLoop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: 'Must not run after failed handoff.' }],
              toolCalls: [],
            },
            { admission: 'newTurn', kind: 'test-post-handoff-producer' },
          ),
        ),
      ).toThrow();
    } finally {
      failingCloseHook?.dispose();
      turnSubscription?.dispose();
      hook.dispose();
      await rpc.close();
    }
  });

  it('closes a cold resume when the snapshot callback fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_cold_resume_snapshot_failure';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    const snapshotError = new Error('snapshot start failed');
    const started: number[] = [];
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type === 'turn.started' && event.sessionId === sessionId) {
        started.push(event.turnId);
      }
    });
    let handoffCalled = false;

    try {
      await rpc.createSession({ id: sessionId, workDir });
      await rpc.closeSession({ sessionId });

      await expect(
        rpc.resumeSessionWithHandoff(
          { id: sessionId },
          async () => {
            handoffCalled = true;
          },
          () => {
            throw snapshotError;
          },
        ),
      ).rejects.toBe(snapshotError);

      expect(handoffCalled).toBe(false);
      expect(started).toEqual([]);
      expect(lifecycle.get(sessionId)).toBeUndefined();
    } finally {
      unsubscribe();
      await rpc.close();
    }
  });

  it('cuts the snapshot before a live resume rematerializes producer work', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_live_resume_missing_main';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    let snapshotStarted = false;
    let producerLoop: IAgentLoopService | undefined;
    let producer: ReturnType<IAgentLoopService['enqueue']> | undefined;
    let signalProducerObserved!: () => void;
    let rejectProducerObserved!: (error: unknown) => void;
    const producerObserved = new Promise<void>((resolve, reject) => {
      signalProducerObserved = resolve;
      rejectProducerObserved = reject;
    });
    void producerObserved.catch(() => undefined);

    try {
      await rpc.createSession({ id: sessionId, workDir });
      const session = lifecycle.get(sessionId);
      if (session === undefined) throw new Error('session was not created');
      const agents = session.accessor.get(IAgentLifecycleService);
      await agents.remove(MAIN_AGENT_ID);
      const onDidCreate = agents.onDidCreate((agent) => {
        if (agent.id !== MAIN_AGENT_ID) return;
        queueMicrotask(() => {
          try {
            expect(snapshotStarted).toBe(true);
            producerLoop = agent.accessor.get(IAgentLoopService);
            producer = producerLoop.enqueue(
              new MessageStepRequest(
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'Work restored with the main agent.' }],
                  toolCalls: [],
                },
                { admission: 'newTurn', kind: 'test-rematerialized-producer' },
              ),
            );
            signalProducerObserved();
          } catch (error) {
            rejectProducerObserved(error);
          }
        });
      });

      try {
        await rpc.resumeSessionWithHandoff(
          { id: sessionId },
          async () => {
            await producerObserved;
            expect(producerLoop?.status()).toMatchObject({
              state: 'idle',
              hasPendingRequests: true,
            });
            expect(producer?.abort()).toBe(true);
          },
          () => {
            expect(snapshotStarted).toBe(false);
            snapshotStarted = true;
          },
        );
      } finally {
        onDidCreate.dispose();
      }
    } finally {
      producer?.abort();
      await rpc.close();
    }
  });

  it('releases a rematerialized main gate when the snapshot callback fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_live_resume_missing_main_snapshot_failure';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const lifecycle = rpc.engineAccessor.get(ISessionLifecycleService);
    let loop: IAgentLoopService | undefined;
    let producer: ReturnType<IAgentLoopService['enqueue']> | undefined;
    let activeHook: { dispose(): void } | undefined;
    let turnSubscription: { dispose(): void } | undefined;
    const started: number[] = [];

    try {
      await rpc.setConfig({
        providers: {
          local: {
            type: 'kimi',
            apiKey: 'sk-test',
          },
        },
        models: {
          'fixture-model': {
            provider: 'local',
            model: 'fixture-model',
            maxContextSize: 262144,
          },
        },
        defaultProvider: 'local',
      });
      await rpc.createSession({ id: sessionId, workDir, model: 'fixture-model' });
      const session = lifecycle.get(sessionId);
      if (session === undefined) throw new Error('session was not created');
      const agents = session.accessor.get(IAgentLifecycleService);
      await agents.remove(MAIN_AGENT_ID);
      const onDidCreate = agents.onDidCreate((agent) => {
        if (agent.id !== MAIN_AGENT_ID) return;
        loop = agent.accessor.get(IAgentLoopService);
        activeHook = loop.hooks.onWillBeginStep.register(
          'test-rematerialized-snapshot-failure',
          async (hookContext, next) => {
            await new Promise<void>((_, reject) => {
              if (hookContext.signal.aborted) {
                reject(hookContext.signal.reason);
                return;
              }
              hookContext.signal.addEventListener(
                'abort',
                () => {
                  reject(hookContext.signal.reason);
                },
                { once: true },
              );
            });
            await next();
          },
        );
        turnSubscription = agent.accessor.get(IEventBus).subscribe('turn.started', (event) => {
          started.push(event.turnId);
        });
      });
      const snapshotError = new Error('snapshot start failed');
      let handoffCalled = false;

      try {
        await expect(
          rpc.resumeSessionWithHandoff(
            { id: sessionId },
            async () => {
              handoffCalled = true;
            },
            () => {
              throw snapshotError;
            },
          ),
        ).rejects.toBe(snapshotError);
      } finally {
        onDidCreate.dispose();
      }
      expect(handoffCalled).toBe(false);
      if (loop === undefined) throw new Error('resume did not rematerialize the main agent');
      const resumedLoop = loop;

      producer = resumedLoop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'Producer after rematerialized snapshot failure.' }],
            toolCalls: [],
          },
          { admission: 'newTurn', kind: 'test-post-rematerialized-snapshot-failure' },
        ),
      );
      let producerAssigned = false;
      void producer.assigned.then(
        () => {
          producerAssigned = true;
        },
        () => {},
      );
      await Promise.resolve();

      expect(producerAssigned).toBe(true);
      expect(started).toEqual([0]);
      expect(resumedLoop.status()).toMatchObject({ state: 'running', activeTurnId: 0 });
      expect(resumedLoop.cancel(0)).toBe(true);
      await resumedLoop.settled();
    } finally {
      producer?.abort();
      loop?.cancel();
      turnSubscription?.dispose();
      activeHook?.dispose();
      await rpc.close();
    }
  });

  it('waits for an active main agent to settle before invoking the handoff callback', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_active_resume_handoff';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    let resume: Promise<unknown> | undefined;
    let activeHook: { dispose(): void } | undefined;
    let loopForCleanup: IAgentLoopService | undefined;

    try {
      await rpc.setConfig({
        providers: {
          local: {
            type: 'kimi',
            apiKey: 'sk-test',
          },
        },
        models: {
          'fixture-model': {
            provider: 'local',
            model: 'fixture-model',
            maxContextSize: 262144,
          },
        },
        defaultProvider: 'local',
      });
      await rpc.createSession({ id: sessionId, workDir, model: 'fixture-model' });
      const session = rpc.engineAccessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) throw new Error('session was not created');
      const main = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
      if (main === undefined) throw new Error('active session has no main agent');
      const loop = main.accessor.get(IAgentLoopService);
      loopForCleanup = loop;
      let signalActiveStarted!: () => void;
      const activeStarted = new Promise<void>((resolve) => {
        signalActiveStarted = resolve;
      });
      activeHook = loop.hooks.onWillBeginStep.register(
        'test-active-resume-handoff',
        async (hookContext, next) => {
          signalActiveStarted();
          await new Promise<void>((_, reject) => {
            if (hookContext.signal.aborted) {
              reject(hookContext.signal.reason);
              return;
            }
            hookContext.signal.addEventListener(
              'abort',
              () => {
                reject(hookContext.signal.reason);
              },
              { once: true },
            );
          });
          await next();
        },
      );
      const active = (
        await loop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: 'Active work before resume.' }],
              toolCalls: [],
            },
            { admission: 'newTurn', kind: 'test-active-resume' },
          ),
        ).assigned
      ).turn;
      await activeStarted;
      let signalSnapshotCut!: () => void;
      const snapshotCut = new Promise<void>((resolve) => {
        signalSnapshotCut = resolve;
      });
      let handoffCalled = false;
      let snapshotStarted = false;
      let producerAssigned = false;
      let producer: ReturnType<IAgentLoopService['enqueue']> | undefined;

      resume = rpc.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          const status = loop.status();
          const aborted = producer?.abort();
          handoffCalled = true;
          expect(snapshotStarted).toBe(true);
          expect(producerAssigned).toBe(false);
          expect(status).toMatchObject({
            state: 'idle',
            hasPendingRequests: true,
          });
          expect(aborted).toBe(true);
        },
        () => {
          expect(snapshotStarted).toBe(false);
          snapshotStarted = true;
          signalSnapshotCut();
        },
      );
      await snapshotCut;
      producer = loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'Produced while active work drains.' }],
            toolCalls: [],
          },
          { admission: 'newTurn', kind: 'test-active-handoff-producer' },
        ),
      );
      void producer.assigned.then(
        () => {
          producerAssigned = true;
        },
        () => {},
      );
      await Promise.resolve();

      expect(handoffCalled).toBe(false);
      expect(snapshotStarted).toBe(true);
      expect(producerAssigned).toBe(false);
      expect(loop.cancel(active.id)).toBe(true);
      await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
      await resume;

      expect(handoffCalled).toBe(true);
    } finally {
      loopForCleanup?.cancel();
      await resume?.catch(() => undefined);
      activeHook?.dispose();
      await rpc.close();
    }
  });

  it('releases an active acquisition after the snapshot callback fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const sessionId = 'session_active_resume_snapshot_failure';
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    let resume: Promise<unknown> | undefined;
    let loop: IAgentLoopService | undefined;
    let activeHook: { dispose(): void } | undefined;
    let turnSubscription: { dispose(): void } | undefined;
    const started: number[] = [];

    try {
      await rpc.setConfig({
        providers: {
          local: {
            type: 'kimi',
            apiKey: 'sk-test',
          },
        },
        models: {
          'fixture-model': {
            provider: 'local',
            model: 'fixture-model',
            maxContextSize: 262144,
          },
        },
        defaultProvider: 'local',
      });
      await rpc.createSession({ id: sessionId, workDir, model: 'fixture-model' });
      const session = rpc.engineAccessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) throw new Error('session was not created');
      const main = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
      if (main === undefined) throw new Error('active session has no main agent');
      loop = main.accessor.get(IAgentLoopService);
      turnSubscription = main.accessor.get(IEventBus).subscribe('turn.started', (event) => {
        started.push(event.turnId);
      });
      let signalActiveStarted!: () => void;
      const activeStarted = new Promise<void>((resolve) => {
        signalActiveStarted = resolve;
      });
      activeHook = loop.hooks.onWillBeginStep.register(
        'test-active-snapshot-failure',
        async (hookContext, next) => {
          signalActiveStarted();
          await new Promise<void>((_, reject) => {
            if (hookContext.signal.aborted) {
              reject(hookContext.signal.reason);
              return;
            }
            hookContext.signal.addEventListener(
              'abort',
              () => {
                reject(hookContext.signal.reason);
              },
              { once: true },
            );
          });
          await next();
        },
      );
      const active = (
        await loop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: 'Active work before snapshot failure.' }],
              toolCalls: [],
            },
            { admission: 'newTurn', kind: 'test-active-snapshot-failure' },
          ),
        ).assigned
      ).turn;
      await activeStarted;
      const snapshotError = new Error('snapshot start failed');
      let signalSnapshotStarted!: () => void;
      const snapshotStarted = new Promise<void>((resolve) => {
        signalSnapshotStarted = resolve;
      });
      let resumeSettled = false;
      let handoffCalled = false;

      resume = rpc.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          handoffCalled = true;
        },
        () => {
          signalSnapshotStarted();
          throw snapshotError;
        },
      );
      void resume.then(
        () => {
          resumeSettled = true;
        },
        () => {
          resumeSettled = true;
        },
      );
      await snapshotStarted;
      await Promise.resolve();

      expect(resumeSettled).toBe(false);
      expect(handoffCalled).toBe(false);
      expect(loop.cancel(active.id)).toBe(true);
      await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
      await expect(resume).rejects.toBe(snapshotError);

      const producer = loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'Producer after snapshot failure.' }],
            toolCalls: [],
          },
          { admission: 'newTurn', kind: 'test-post-snapshot-failure-producer' },
        ),
      );
      let producerAssigned = false;
      void producer.assigned.then(
        () => {
          producerAssigned = true;
        },
        () => {},
      );
      await Promise.resolve();

      expect(producerAssigned).toBe(true);
      expect(started).toEqual([0, 1]);
      expect(loop.status()).toMatchObject({ state: 'running', activeTurnId: 1 });
      expect(loop.cancel(1)).toBe(true);
      await loop.settled();
    } finally {
      loop?.cancel();
      await resume?.catch(() => undefined);
      turnSubscription?.dispose();
      activeHook?.dispose();
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
