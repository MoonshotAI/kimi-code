import { describe, expect, it, vi } from 'vitest';

import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentRuntimeHost } from '#/actor/internal/agentRuntimeHost';
import { ActorHostService } from '#/actor/actorHost';

const agent = { agentId: 'main', generation: 1 } as AgentContext;

describe('Agent Domain', () => {
  it('routes prompt and cancel through the runtime host and closes idempotently', async () => {
    const prompt = vi.fn(async () => undefined as never);
    const cancel = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const service = new ActorHostService();
    const domain = await service.createAgent('session-1', agent.agentId, async () => ({
      agent,
      host: { prompt, cancel, close } as unknown as AgentRuntimeHost,
    }));

    expect(domain.agentId).toBe('main');
    expect(domain.state()).toBe('active');
    await domain.prompt({ message: {} as never });
    await domain.cancel('stop');
    await Promise.all([domain.close(), domain.close()]);

    expect(prompt).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('stop');
    expect(close).toHaveBeenCalledOnce();
    expect(domain.state()).toBe('closed');
    expect(() => domain.prompt({ message: {} as never })).toThrow(/closed/);
    await service.dispose();
  });
});
