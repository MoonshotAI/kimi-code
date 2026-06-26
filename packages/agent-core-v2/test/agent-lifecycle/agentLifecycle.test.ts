import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentLifecycleService } from '#/agent-lifecycle/agentLifecycleService';
import { ISessionMetaStore } from '#/records/records';
import { ISessionContext } from '#/session-context/sessionContext';

describe('AgentLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionContext, {});
    ix.stub(ISessionMetaStore, {});
  });
  afterEach(() => disposables.dispose());

  it('create / getHandle / list / remove', async () => {
    const svc = disposables.add(ix.createInstance(AgentLifecycleService));
    const main = await svc.createMain();
    expect(main.id).toBe('main');
    expect(svc.getHandle('main')).toBe(main);
    expect(svc.list()).toEqual([main]);
    await svc.remove('main');
    expect(svc.getHandle('main')).toBeUndefined();
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = disposables.add(ix.createInstance(AgentLifecycleService));
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.id).not.toBe(b.id);
  });
});
