import { describe, expect, it } from 'vitest';

import { InstantiationService } from '#/_base/di/instantiationService';

import { AgentLifecycleService } from '#/agent-lifecycle/agentLifecycleService';

describe('AgentLifecycleService', () => {
  it('create / getHandle / list / remove', async () => {
    const svc = new AgentLifecycleService(
      undefined as never,
      undefined as never,
      new InstantiationService(),
    );
    const main = await svc.createMain();
    expect(main.id).toBe('main');
    expect(svc.getHandle('main')).toBe(main);
    expect(svc.list()).toEqual([main]);
    await svc.remove('main');
    expect(svc.getHandle('main')).toBeUndefined();
    svc.dispose();
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = new AgentLifecycleService(
      undefined as never,
      undefined as never,
      new InstantiationService(),
    );
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.id).not.toBe(b.id);
    svc.dispose();
  });
});
