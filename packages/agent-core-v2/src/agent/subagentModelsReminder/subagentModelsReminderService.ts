import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IConfigService } from '#/app/config/config';
import { isPlainObject } from '#/app/config/toml';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionResult } from '#/features/reminder/types';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';

import {
  IAgentSubagentModelsReminderService,
  type SubagentModelsDisclosure,
} from './subagentModelsReminder';

export const SUBAGENT_MODELS_REMINDER_VARIANT = 'subagent_models';

export class AgentSubagentModelsReminderService
  extends Disposable
  implements IAgentSubagentModelsReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentLoopService private readonly profile: IAgentLoopService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this._register(
      reminder.register<SubagentModelsDisclosure>(
        SUBAGENT_MODELS_REMINDER_VARIANT,
        ({ lastDisclosure }) => this.inject(lastDisclosure),
      ),
    );
  }

  private inject(
    lastDisclosure: unknown,
  ): ContextInjectionResult<SubagentModelsDisclosure> | undefined {
    const profileData = this.profile.data();
    if (profileData.profileName === undefined) return undefined;
    if (!this.hasActiveSubagentTool()) return undefined;
    const current = resolveDisclosure(this.config, profileData.modelAlias);
    if (current === undefined) return undefined;
    const previous = isSubagentModelsDisclosure(lastDisclosure) ? lastDisclosure : undefined;
    if (previous !== undefined && sameDisclosure(previous, current)) return undefined;
    return {
      content: renderSubagentModelsReminder(current, previous !== undefined),
      disclosure: current,
    };
  }

  private hasActiveSubagentTool(): boolean {
    return (
      this.toolPolicy.isToolActive('Agent') ||
      this.toolPolicy.isToolActive('AgentSwarm') ||
      this.toolPolicy.isToolActive('TowerSpawn')
    );
  }
}

function resolveDisclosure(
  config: IConfigService,
  ownModelAlias: string | undefined,
): SubagentModelsDisclosure | undefined {
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) {
    if (Object.keys(pool.models).length === 0) return undefined;
    return { defaultModel: pool.defaultModel, models: { ...pool.models } };
  }
  if (ownModelAlias === undefined) return undefined;
  return { defaultModel: ownModelAlias, models: { [ownModelAlias]: '' } };
}

function isSubagentModelsDisclosure(value: unknown): value is SubagentModelsDisclosure {
  if (!isPlainObject(value)) return false;
  if (value['defaultModel'] !== undefined && typeof value['defaultModel'] !== 'string') {
    return false;
  }
  const models = value['models'];
  if (!isPlainObject(models)) return false;
  return Object.values(models).every((entry) => typeof entry === 'string');
}

function sameDisclosure(
  left: SubagentModelsDisclosure,
  right: SubagentModelsDisclosure,
): boolean {
  if (left.defaultModel !== right.defaultModel) return false;
  const leftKeys = Object.keys(left.models);
  const rightKeys = Object.keys(right.models);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => rightKeys[index] === key && right.models[key] === left.models[key])
  );
}

function orderedAliases(disclosure: SubagentModelsDisclosure): string[] {
  const aliases = Object.keys(disclosure.models);
  const { defaultModel } = disclosure;
  if (defaultModel === undefined || !Object.hasOwn(disclosure.models, defaultModel)) {
    return aliases;
  }
  return [defaultModel, ...aliases.filter((alias) => alias !== defaultModel)];
}

function formatModelLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
}

function renderSubagentModelsReminder(
  disclosure: SubagentModelsDisclosure,
  changed: boolean,
): string {
  const lines = ['Available subagent models (pass via model):'];
  for (const alias of orderedAliases(disclosure)) {
    const marker = alias === disclosure.defaultModel ? ' [default]' : '';
    lines.push(formatModelLine(`${alias}${marker}`, disclosure.models[alias] ?? ''));
  }
  const listing = lines.join('\n');
  if (!changed) return listing;
  return `The available subagent models changed; the list below replaces any earlier subagent model list.\n\n${listing}`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSubagentModelsReminderService,
  AgentSubagentModelsReminderService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
