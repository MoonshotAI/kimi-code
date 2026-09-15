import {
  createDecorator,
  Feature,
  IFeatureManager,
  LifecycleScope,
  Service,
  createAppScope,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { describeAllChannels, resolveAnyScopedServiceId } from '../src/transport/channelRegistry';

describe('channelRegistry', () => {
  it('describes only real DI scopes', () => {
    const scopes = new Set(describeAllChannels().map((channel) => channel.scope));
    expect(scopes).toEqual(new Set(['app', 'session', 'agent']));
  });

  it('resolves contributed services from the current core only', async () => {
    const id = createDecorator<unknown>('test-contributed-service');
    class TestService extends Service {}
    class TestFeature extends Feature {
      constructor() {
        super();
        this.contributeService(LifecycleScope.Agent, id, TestService);
      }
    }
    const first = createAppScope();
    const second = createAppScope();
    const firstManager = first.accessor.get(IFeatureManager);
    const secondManager = second.accessor.get(IFeatureManager);
    firstManager.provideUnit(TestFeature);
    secondManager.provideUnit(TestFeature);

    expect(resolveAnyScopedServiceId(first, String(id))).toBe(id);
    expect(resolveAnyScopedServiceId(second, String(id))).toBe(id);

    await firstManager.unprovideUnit('TestFeature');
    expect(resolveAnyScopedServiceId(first, String(id))).toBeUndefined();
    expect(resolveAnyScopedServiceId(second, String(id))).toBe(id);

    await secondManager.unprovideUnit('TestFeature');
    expect(resolveAnyScopedServiceId(second, String(id))).toBeUndefined();
    first.dispose();
    second.dispose();
  });
});
