import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBackgroundService } from '#/agent/background';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IExecContext } from '#/session/execContext';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { AgentToolService, IAgentToolService } from '#/agent/agentTool';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { ISessionMetadata } from '#/session/session-metadata';
import { ISessionProcessRunner } from '#/session/process';

describe('AgentToolService DI wiring', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });

  afterEach(() => disposables.dispose());

  it('registers the Agent tool bound to the current agent', () => {
    const register = vi.fn(() => ({ dispose: () => {} }));
    ix.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main' });
    ix.stub(IAgentLifecycleService, {});
    ix.stub(ISessionMetadata, {
      read: vi.fn().mockResolvedValue({ agents: {} }),
    });
    ix.stub(IAgentToolRegistryService, { register });
    ix.stub(IAgentBackgroundService, {});
    ix.stub(IAgentProfileService, { isToolActive: vi.fn().mockReturnValue(false) });
    ix.stub(IExecContext, { cwd: '/repo' });
    ix.stub(ISessionProcessRunner, { exec: vi.fn() });
    ix.stub(ILogService, { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });
    ix.set(IAgentToolService, new SyncDescriptor(AgentToolService, [undefined]));

    const service = ix.get(IAgentToolService);

    expect(service).toBeInstanceOf(AgentToolService);
    expect(register).toHaveBeenCalledTimes(1);
  });
});
