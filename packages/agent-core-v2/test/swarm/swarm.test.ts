import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IPermissionService } from '#/permission/permission';
import { IAgentRecords } from '#/records/records';
import { SwarmService } from '#/swarm/swarmService';

describe('SwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, {});
    ix.stub(IAgentLifecycleService, {});
    ix.stub(IPermissionService, {});
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle active', async () => {
    const swarm = disposables.add(ix.createInstance(SwarmService));
    expect(swarm.active).toBe(false);
    await swarm.enter();
    expect(swarm.active).toBe(true);
    swarm.exit();
    expect(swarm.active).toBe(false);
  });
});
