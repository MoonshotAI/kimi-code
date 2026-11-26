import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, type TestContext } from 'vitest';

import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { IAgentModeMutexService } from '#/agent/modeMutex/modeMutex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { GoalUpdated } from '#/features/goal/goalOps';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { WireRecord } from '#/wire/record';

import { stubFlag } from '../../app/flag/stubs';
import {
  appService,
  InMemoryWireRecordPersistence,
  sessionService,
  testkitAgentFixtures,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentInput,
} from '../../harness';

_setTowerFeatureAssembledForTests(true);

async function withAgent(
  context: TestContext,
  body: (agent: TestAgentContext) => Promise<void>,
  ...extraInputs: readonly TestAgentInput[]
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'mode-mutex-e2e-'));
  try {
    const fixtures = testkitAgentFixtures(
      appService(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID)),
      { cwd },
      ...extraInputs,
    );
    await fixtures.model(context, async (model) => {
      await fixtures.agent({ model }, async (agent) => {
        await agent.restorePersisted();
        await body(agent);
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('AgentModeMutexService integration', () => {
  it('instantiates the mutex service in a real agent scope', async (context) => {
    await withAgent(context, async (agent) => {
      expect(agent.get(IAgentModeMutexService)).toBeDefined();
    });
  });

  it('entering plan exits active tower', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentTowerService).enter();
      expect(agent.get(IAgentTowerService).isActive).toBe(true);

      await agent.get(IAgentPlanService).enter();

      expect(await agent.get(IAgentPlanService).status()).not.toBeNull();
      expect(agent.get(IAgentTowerService).isActive).toBe(false);
    });
  });

  it('entering swarm exits active tower', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentTowerService).enter();
      expect(agent.get(IAgentTowerService).isActive).toBe(true);

      agent.get(IAgentSwarmService).enter('manual');

      expect(agent.get(IAgentSwarmService).isActive).toBe(true);
      expect(agent.get(IAgentTowerService).isActive).toBe(false);
    });
  });

  it('entering tower exits active plan', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentPlanService).enter();

      await agent.get(IAgentTowerService).enter();

      expect(agent.get(IAgentTowerService).isActive).toBe(true);
      expect(await agent.get(IAgentPlanService).status()).toBeNull();
    });
  });

  it('entering tower exits active swarm', async (context) => {
    await withAgent(context, async (agent) => {
      agent.get(IAgentSwarmService).enter('manual');

      await agent.get(IAgentTowerService).enter();

      expect(agent.get(IAgentTowerService).isActive).toBe(true);
      expect(agent.get(IAgentSwarmService).isActive).toBe(false);
    });
  });

  it('entering tower pauses an active goal and publishes the paused snapshot', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentGoalService).createGoal({ objective: 'ship it' });
      const updates: Array<string | undefined> = [];
      agent.get(IEventBus).subscribe(GoalUpdated, (event) => {
        updates.push(event.snapshot?.status);
      });

      await agent.get(IAgentTowerService).enter();

      expect(agent.get(IAgentTowerService).isActive).toBe(true);
      expect(agent.get(IAgentGoalService).getGoal().goal?.status).toBe('paused');
      expect(updates).toEqual(['paused']);
    });
  });

  it('creating a goal exits active tower', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentTowerService).enter();

      await agent.get(IAgentGoalService).createGoal({ objective: 'ship it' });

      expect(agent.get(IAgentGoalService).getGoal().goal?.status).toBe('active');
      expect(agent.get(IAgentTowerService).isActive).toBe(false);
    });
  });

  it('resuming a goal exits active tower', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentGoalService).createGoal({ objective: 'ship it' });
      await agent.get(IAgentGoalService).pauseGoal();
      await agent.get(IAgentTowerService).enter();

      await agent.get(IAgentGoalService).resumeGoal();

      expect(agent.get(IAgentGoalService).getGoal().goal?.status).toBe('active');
      expect(agent.get(IAgentTowerService).isActive).toBe(false);
    });
  });

  it('reconciles legacy sessions restored with tower and other modes active together', async (context) => {
    const records: WireRecord[] = [
      { type: 'tower_mode.enter', agentId: 'main', sessionId: 'test-session', time: 1 },
      { type: 'plan_mode.enter', agentId: 'main', id: 'legacy-plan', time: 2 },
      { type: 'swarm_mode.enter', agentId: 'main', trigger: 'manual', time: 3 },
      { type: 'goal.create', agentId: 'main', goalId: 'g1', objective: 'legacy goal', time: 4 },
    ];
    await withAgent(
      context,
      async (agent) => {
        expect(agent.get(IAgentTowerService).isActive).toBe(true);
        expect(await agent.get(IAgentPlanService).status()).toBeNull();
        expect(agent.get(IAgentSwarmService).isActive).toBe(false);
        expect(agent.get(IAgentGoalService).getGoal().goal?.status).toBe('paused');
      },
      { autoStart: false },
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(records)),
    );
  });

  it('reconciles a live foreign tower owner before applying mutex on restore', async (context) => {
    const records: WireRecord[] = [
      { type: 'tower_mode.enter', agentId: 'main', sessionId: 'session-original', time: 1 },
      { type: 'plan_mode.enter', agentId: 'main', id: 'fork-plan', time: 2 },
      { type: 'swarm_mode.enter', agentId: 'main', trigger: 'manual', time: 3 },
      { type: 'goal.create', agentId: 'main', goalId: 'g1', objective: 'keep me intact', time: 4 },
    ];
    const persistence = new InMemoryWireRecordPersistence(records);
    await withAgent(
      context,
      async (agent) => {
        expect(agent.get(IAgentTowerService).isActive).toBe(false);
        expect(await agent.get(IAgentPlanService).status()).toMatchObject({ id: 'fork-plan' });
        expect(agent.get(IAgentSwarmService).isActive).toBe(true);
        expect(agent.get(IAgentGoalService).getGoal().goal?.status).toBe('paused');
        const goalUpdates = persistence.records.filter(
          (record) => record.type === 'goal.update',
        );
        expect(goalUpdates).toEqual([
          expect.objectContaining({ reason: 'Paused after agent resume', actor: 'runtime' }),
        ]);
      },
      { autoStart: false },
      wireRecordPersistenceServices(persistence),
      sessionService(ISessionManager, {
        get: (id: string) =>
          id === 'session-original' ? ({} as ISessionScopeHandle) : undefined,
        list: () => [],
        onDidCreateSession: Event.None,
        onWillCloseSession: Event.None,
      } as unknown as ISessionManager),
    );
  });

  it('keeps tower active when plan directory creation fails', async (context) => {
    await withAgent(context, async (agent) => {
      await agent.get(IAgentTowerService).enter();
      const mkdir = vi
        .spyOn(agent.get(IHostFileSystem), 'mkdir')
        .mockRejectedValueOnce(new Error('EACCES: read-only file system'));
      try {
        await expect(agent.get(IAgentPlanService).enter()).rejects.toThrow('EACCES');
        expect(await agent.get(IAgentPlanService).status()).toBeNull();
        expect(agent.get(IAgentTowerService).isActive).toBe(true);
      } finally {
        mkdir.mockRestore();
      }
    });
  });
});
