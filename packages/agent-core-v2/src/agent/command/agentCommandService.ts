import { Emitter, type Event } from '#/_base/event';
import { type CollectionRecord, type CollectionView } from '#/_base/di/collection';
import {
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';

import { IAgentCommandService, type AgentCommandInfo } from './agentCommand';
import { CommandContribution } from './commandContribution';

export class AgentCommandService extends Service implements IAgentCommandService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @CommandContribution private readonly contributions: CollectionView<CommandContribution>,
  ) {
    super();
    this._register(this.contributions.onDidChange(() => this._onDidChange.fire()));
  }

  list(): readonly AgentCommandInfo[] {
    const byName = new Map<string, AgentCommandInfo>();
    for (const record of this.contributions.records) {
      byName.set(record.value.name, {
        name: record.value.name,
        description: record.value.description,
        source: record.providerName,
      });
    }
    return [...byName.values()];
  }

  async run(name: string, args = ''): Promise<void> {
    const record = this.find(name);
    if (record === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown command "${name}"`);
    }
    await this.instantiationService.invokeFunction((accessor) =>
      record.value.run({ args, get: <T>(id: ServiceIdentifier<T>): T => accessor.get(id) }),
    );
  }

  private find(name: string): CollectionRecord<CommandContribution> | undefined {
    let found: CollectionRecord<CommandContribution> | undefined;
    for (const record of this.contributions.records) {
      if (record.value.name === name) found = record;
    }
    return found;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCommandService,
  AgentCommandService,
  ScopeActivation.OnDemand,
  'command',
);
