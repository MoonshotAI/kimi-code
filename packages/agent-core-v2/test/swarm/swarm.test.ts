import { describe, expect, it } from 'vitest';

import { SwarmService } from '#/swarm/swarmService';

describe('SwarmService', () => {
  it('enter / exit toggle active', async () => {
    const swarm = new SwarmService(undefined as never, undefined as never, undefined as never);
    expect(swarm.active).toBe(false);
    await swarm.enter();
    expect(swarm.active).toBe(true);
    swarm.exit();
    expect(swarm.active).toBe(false);
    swarm.dispose();
  });
});
