import { describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { AgentEvent } from '../../src/rpc';
import { testAgent } from './harness/agent';

describe('Agent slim handle', () => {
  it('exposes the expected service handles as a stable aggregate', () => {
    const { agent } = testAgent();

    // Core service handles are present on the public surface.
    expect(agent.turn).toBeDefined();
    expect(agent.config).toBeDefined();
    expect(agent.context).toBeDefined();
    expect(agent.permission).toBeDefined();
    expect(agent.tools).toBeDefined();
    expect(agent.records).toBeDefined();
    expect(agent.usage).toBeDefined();
    expect(agent.eventBus).toBeDefined();
    expect(agent.lifecycle).toBeDefined();
    expect(agent.statusService).toBeDefined();
    expect(agent.rpcController).toBeDefined();
    expect(agent.resumeService).toBeDefined();
    expect(agent.profileService).toBeDefined();

    // The handle is a stable aggregate: repeated access returns the same instance.
    expect(agent.turn).toBe(agent.turn);
    expect(agent.config).toBe(agent.config);
    expect(agent.eventBus).toBe(agent.eventBus);
    expect(agent.lifecycle).toBe(agent.lifecycle);
  });

  it('exposes the read-only identity fields', () => {
    const { agent } = testAgent();

    expect(agent.type).toBe('main');
    expect(agent.id).toBeUndefined();
    expect(agent.kaos).toBeDefined();
  });

  it('forwards the generate / llm / rpcMethods getters to the owning services', () => {
    const { agent } = testAgent();

    // `llmService.generate` is a function-valued getter, which vitest's typed
    // `spyOn(..., 'get')` overload does not accept. Redefine the getter on the
    // instance to hand back a sentinel, then assert the Agent getter forwards it.
    const sentinelGenerate = (() =>
      undefined) as unknown as typeof agent.llmService.generate;
    Object.defineProperty(agent.llmService, 'generate', {
      configurable: true,
      get: () => sentinelGenerate,
    });
    expect(agent.generate).toBe(sentinelGenerate);

    // `llm` and `rpcMethods` are object-valued getters, so intercept the getter
    // and hand back a sentinel to prove the Agent getter forwards to the service.
    const sentinelLlm = { sentinel: 'llm' } as unknown as typeof agent.llmService.llm;
    const sentinelRpcMethods = {
      prompt: () => undefined,
    } as unknown as typeof agent.rpcController.rpcMethods;

    vi.spyOn(agent.llmService, 'llm', 'get').mockReturnValue(sentinelLlm);
    vi.spyOn(agent.rpcController, 'rpcMethods', 'get').mockReturnValue(sentinelRpcMethods);

    expect(agent.llm).toBe(sentinelLlm);
    expect(agent.rpcMethods).toBe(sentinelRpcMethods);
  });

  it('delegates resume() and useProfile() to the resume and profile services', async () => {
    const { agent } = testAgent();

    const resumeSpy = vi
      .spyOn(agent.resumeService, 'resume')
      .mockResolvedValue({ warning: 'heads-up' });
    const profileSpy = vi.spyOn(agent.profileService, 'useProfile').mockImplementation(() => {});

    const result = await agent.resume({ rewriteMigratedRecords: false });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith({ rewriteMigratedRecords: false });
    expect(result).toEqual({ warning: 'heads-up' });

    const profile: ResolvedAgentProfile = {
      name: 'tester',
      tools: ['Bash', 'Read'],
      systemPrompt: () => 'PROMPT',
    };
    const context = { cwdListing: 'LISTING', agentsMd: 'AGENTS' };

    agent.useProfile(profile, context);

    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledWith(profile, context);
  });

  it('delegates emitEvent() to the domain event bus', () => {
    const { agent } = testAgent();

    const publishSpy = vi.spyOn(agent.eventBus, 'publish').mockImplementation(() => {});

    const event: AgentEvent = { type: 'warning', message: 'be careful' };
    agent.emitEvent(event);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(event);
  });
});
