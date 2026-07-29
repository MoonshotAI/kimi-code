import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  createAppScope,
} from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import {
  _clearAgentToolContributionsForTests,
  getAgentToolContributions,
  registerAgentToolService,
  type AgentToolContribution,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
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
const ISelectToolsTool = createDecorator<AgentTool>('activationTestSelectToolsTool');

let alphaConstructions = 0;
let betaConstructions = 0;
let gammaConstructions = 0;
let selectToolsConstructions = 0;

class AlphaTool extends StubTool {
  constructor() {
    super('Alpha');
    alphaConstructions += 1;
  }
}

class BetaTool extends StubTool {
  constructor() {
    super('Beta');
    betaConstructions += 1;
  }
}

class GammaTool extends StubTool {
  constructor() {
    super('Gamma');
    gammaConstructions += 1;
  }
}

class SelectToolsTool extends StubTool {
  constructor() {
    super(SELECT_TOOLS_TOOL_NAME);
    selectToolsConstructions += 1;
  }
}

describe('AgentToolActivationService', () => {
  let savedContributions: readonly AgentToolContribution[];
  let disposables: DisposableStore;
  let toolSelectEnabled: boolean;
  let disclosureToolActive: boolean;
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
        reg.definePartialInstance(IAgentToolSelectService, {
          enabled: () => toolSelectEnabled,
        });
        reg.definePartialInstance(IAgentToolPolicyService, {
          isToolActiveForDisclosure: () => disclosureToolActive,
        });
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolActivationService, AgentToolActivationService);
        reg.define(IAlphaTool, AlphaTool);
        reg.define(IBetaTool, BetaTool);
        reg.define(IGammaTool, GammaTool);
        reg.define(ISelectToolsTool, SelectToolsTool);
      },
    });
  }

  beforeEach(() => {
    savedContributions = [...getAgentToolContributions()];
    disposables = new DisposableStore();
    alphaConstructions = 0;
    betaConstructions = 0;
    gammaConstructions = 0;
    selectToolsConstructions = 0;
    toolSelectEnabled = false;
    disclosureToolActive = true;
    _clearAgentToolContributionsForTests();
    delete profileData.activeToolNames;
    delete profileData.disallowedTools;
  });

  afterEach(() => {
    disposables.dispose();
    _clearAgentToolContributionsForTests();
    for (const contribution of savedContributions) {
      registerAgentToolService(contribution.id, contribution.ctor, contribution.options);
    }
  });

  it('keeps an AgentTool unconstructed during scope creation and resolves a real instance', () => {
    _clearScopedRegistryForTests();
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 'session');
    const agent = session.createChild(LifecycleScope.Agent, 'agent');

    expect(alphaConstructions).toBe(0);
    const tool = agent.accessor.get(IAlphaTool);
    expect(tool).toBeInstanceOf(AlphaTool);
    expect(alphaConstructions).toBe(1);
    app.dispose();
  });

  it('activates every contribution when the profile has no allowlist', async () => {
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);
  });

  it('activates select_tools for disclosure when the profile omits it', async () => {
    profileData.activeToolNames = ['Alpha', 'mcp__*'];
    toolSelectEnabled = true;
    registerAgentToolService(ISelectToolsTool, SelectToolsTool, {
      name: SELECT_TOOLS_TOOL_NAME,
    });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve(SELECT_TOOLS_TOOL_NAME)).toBeInstanceOf(
      SelectToolsTool,
    );
    expect(selectToolsConstructions).toBe(1);
  });

  it('does not activate select_tools through disclosure when the gate is closed', async () => {
    profileData.activeToolNames = ['Alpha', 'mcp__*'];
    registerAgentToolService(ISelectToolsTool, SelectToolsTool, {
      name: SELECT_TOOLS_TOOL_NAME,
    });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve(SELECT_TOOLS_TOOL_NAME)).toBeUndefined();
    expect(selectToolsConstructions).toBe(0);
  });

  it('does not activate select_tools through disclosure when the policy disables it', async () => {
    profileData.activeToolNames = ['Alpha', 'mcp__*'];
    toolSelectEnabled = true;
    disclosureToolActive = false;
    registerAgentToolService(ISelectToolsTool, SelectToolsTool, {
      name: SELECT_TOOLS_TOOL_NAME,
    });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve(SELECT_TOOLS_TOOL_NAME)).toBeUndefined();
    expect(selectToolsConstructions).toBe(0);
  });

  it('activates only the tools allowed by the profile allowlist', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
    expect(betaConstructions).toBe(0);
  });

  it('honors the profile disallowedTools', async () => {
    profileData.disallowedTools = ['Beta'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
    expect(betaConstructions).toBe(0);
  });

  it('skips contributions whose when predicate fails', async () => {
    registerAgentToolService(IGammaTool, GammaTool, { name: 'Gamma', when: () => false });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve('Gamma')).toBeUndefined();
    expect(gammaConstructions).toBe(0);
  });

  it('is idempotent and picks up newly allowed tools on re-activation', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
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
