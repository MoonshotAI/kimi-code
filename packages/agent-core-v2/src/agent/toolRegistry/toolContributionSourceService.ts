import type { CollectionView } from '#/_base/di/collection';
import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  AgentToolContribution,
  AgentToolProviderContribution,
  type AgentToolContribution as AgentToolContributionRecord,
  type AgentToolProviderContribution as AgentToolProviderContributionRecord,
} from './toolContribution';

export interface IAgentToolContributionSource {
  readonly _serviceBrand: undefined;
  readonly view: CollectionView<AgentToolContributionRecord>;
  readonly providers: CollectionView<AgentToolProviderContributionRecord>;
}

export const IAgentToolContributionSource = createDecorator<IAgentToolContributionSource>(
  'agentToolContributionSource',
);

export class AgentToolContributionSource implements IAgentToolContributionSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @AgentToolContribution readonly view: CollectionView<AgentToolContributionRecord>,
    @AgentToolProviderContribution readonly providers: CollectionView<AgentToolProviderContributionRecord>,
  ) {}
}

registerScopedService(
  LifecycleScope.Session,
  IAgentToolContributionSource,
  AgentToolContributionSource,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
