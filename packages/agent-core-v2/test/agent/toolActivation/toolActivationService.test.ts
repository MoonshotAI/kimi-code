import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createDecorator } from '#/_base/di/instantiation';
import { createServices } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import {
  _clearAgentToolContributionsForTests,
  getAgentToolContributions,
  registerAgentTool,
  type AgentToolContribution,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

class StubTool implements AgentTool {
  declare readonly _serviceBrand: undefined;
  readonly description = 'stub';
  readonly parameters: Record<string, unknown> = {};
  constructor(readonly name: string) {}
  resolveExecution(): ToolExecution {
    return { isError: true, output: 'stub' };
  }
}

const IAlphaTool = createDecorator<AgentTool>('activationTestAlphaTool');
const IBetaTool = createDecorator<AgentTool>('activationTestBetaTool');
const IGammaTool = createDecorator<AgentTool>('activationTestGammaTool');

class AlphaTool extends StubTool {
  constructor() {
    super('Alpha');
  }
}

class BetaTool extends StubTool {
  constructor() {
    super('Beta');
  }
}

class GammaTool extends StubTool {
  constructor() {
    super('Gamma');
  }
}

describe('AgentToolActivationService', () => {
  let savedContributions: readonly AgentToolContribution[];
  let disposables: DisposableStore;
  const profileData: {
    activeToolNames?: readonly string[];
    disallowedTools?: readonly string[];
  } = {};

  function createActivationHost() {
    disposables = new DisposableStore();
    return createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentProfileService, {
          data: () => profileData as ProfileData,
        });
        reg.definePartialInstance(IEventBus, {
          subscribe: () => toDisposable(() => {}),
        });
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolActivationService, AgentToolActivationService);
        reg.define(IAlphaTool, AlphaTool);
        reg.define(IBetaTool, BetaTool);
        reg.define(IGammaTool, GammaTool);
      },
    });
  }

  beforeEach(() => {
    savedContributions = [...getAgentToolContributions()];
    _clearAgentToolContributionsForTests();
    delete profileData.activeToolNames;
    delete profileData.disallowedTools;
  });

  afterEach(() => {
    disposables.dispose();
    _clearAgentToolContributionsForTests();
    for (const contribution of savedContributions) {
      registerAgentTool(contribution.id, contribution.ctor, contribution.options);
    }
  });

  it('activates every contribution when the profile has no allowlist', async () => {
    registerAgentTool(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentTool(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);
  });

  it('activates only the tools allowed by the profile allowlist', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentTool(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentTool(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
  });

  it('honors the profile disallowedTools', async () => {
    profileData.disallowedTools = ['Beta'];
    registerAgentTool(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentTool(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
  });

  it('skips contributions whose when predicate fails', async () => {
    registerAgentTool(IGammaTool, GammaTool, { name: 'Gamma', when: () => false });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve('Gamma')).toBeUndefined();
  });

  it('is idempotent and picks up newly allowed tools on re-activation', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentTool(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentTool(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();
    const activation = ix.get(IAgentToolActivationService);
    const registry = ix.get(IAgentToolRegistryService);

    await activation.activate();
    const alpha = registry.resolve('Alpha');
    expect(alpha).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();

    profileData.activeToolNames = ['Alpha', 'Beta'];
    await activation.activate();

    expect(registry.resolve('Alpha')).toBe(alpha);
    expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);
  });
});
