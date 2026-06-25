import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { ISwarmService } from '#/swarm/swarm';
import { SwarmService } from '#/swarm/swarmService';
import { registerAgentLifecycleServices } from '../agent-lifecycle/stubs';
import { registerPermissionServices } from '../permission/stubs';
import { registerRecordsServices } from '../records/stubs';

describe('SwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerRecordsServices,
        registerAgentLifecycleServices,
        registerPermissionServices,
      ],
      additionalServices: (reg) => {
        reg.define(ISwarmService, SwarmService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle active', async () => {
    const swarm = ix.get(ISwarmService);
    expect(swarm.active).toBe(false);
    await swarm.enter();
    expect(swarm.active).toBe(true);
    swarm.exit();
    expect(swarm.active).toBe(false);
  });
});
