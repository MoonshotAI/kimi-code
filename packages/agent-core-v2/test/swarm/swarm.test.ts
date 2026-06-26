import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory } from '#/contextMemory';
import { IEventBus } from '#/eventBus';
import { ISubagentHost } from '#/subagentHost';
import { ISwarmService } from '#/swarm';
import { SwarmService } from '#/swarm/swarmService';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService } from '#/turn';
import { IWireRecord } from '#/wireRecord';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

describe('SwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IContextMemory, stubContextMemory());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IEventBus, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(ITurnService, stubTurnWithHooks());
    ix.stub(IToolRegistry, {});
    ix.stub(ISubagentHost, {});
    ix.set(ISwarmService, new SyncDescriptor(SwarmService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive', async () => {
    const swarm = ix.get(ISwarmService);
    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);
  });
});
