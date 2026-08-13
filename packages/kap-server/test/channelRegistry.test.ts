import {
  createDecorator,
  recordContributedService,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { resolveAnyScopedServiceId } from '../src/transport/channelRegistry';

describe('channelRegistry', () => {
  it('stops resolving a contributed service after its provider withdraws', () => {
    const id = createDecorator<unknown>('test-contributed-service');
    const provider = recordContributedService('agent', id);

    expect(resolveAnyScopedServiceId(String(id))).toBe(id);

    provider.dispose();
    expect(resolveAnyScopedServiceId(String(id))).toBeUndefined();
  });
});
