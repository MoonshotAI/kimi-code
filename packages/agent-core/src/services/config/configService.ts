import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { KimiConfig, ProviderConfig } from '../../config';
import type { ConfigResponse, PatchConfigRequest } from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { IConfigService } from './config';

export class ConfigService extends Disposable implements IConfigService {
  readonly _serviceBrand: undefined;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
  }

  async get(): Promise<ConfigResponse> {
    const config = await this.core.rpc.getKimiConfig({ reload: true });
    return toConfigResponse(config);
  }

  async set(patch: PatchConfigRequest): Promise<ConfigResponse> {
    const camelPatch = convertPatchKeys(patch);
    const updated = await this.core.rpc.setKimiConfig(camelPatch);
    const response = toConfigResponse(updated);

    this.eventService.publish({
      type: 'event.config.changed',
      agentId: 'main',
      sessionId: '__global__',
      changedFields: Object.keys(patch),
      config: response,
    });

    return response;
  }
}

function toConfigResponse(config: KimiConfig): ConfigResponse {
  const providers: Record<string, { type: string; base_url?: string; default_model?: string; has_api_key: boolean }> = {};
  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    providers[providerId] = {
      type: provider.type,
      base_url: provider.baseUrl,
      default_model: provider.defaultModel,
      has_api_key: hasProviderCredential(provider),
    };
  }

  return {
    providers,
    default_provider: config.defaultProvider,
    default_model: config.defaultModel,
    models: config.models,
    thinking: config.thinking,
    plan_mode: config.planMode,
    yolo: config.yolo,
    default_permission_mode: config.defaultPermissionMode,
    default_plan_mode: config.defaultPlanMode,
    permission: config.permission,
    hooks: config.hooks,
    services: config.services,
    merge_all_available_skills: config.mergeAllAvailableSkills,
    extra_skill_dirs: config.extraSkillDirs,
    loop_control: config.loopControl,
    background: config.background,
    experimental: config.experimental as Record<string, boolean> | undefined,
    telemetry: config.telemetry,
    raw: config.raw,
  };
}

function hasProviderCredential(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.oauth !== undefined) return true;
  return false;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Convert only the known top-level config field names from snake_case to
 * camelCase. Nested values (provider configs, model aliases, hooks, etc.) are
 * passed through untouched so arbitrary user data is not mutated.
 */
function convertPatchKeys(patch: PatchConfigRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const camelKey = PATCH_KEY_MAP[key] ?? key;
    result[camelKey] = value;
  }
  return result;
}

const PATCH_KEY_MAP: Record<string, string> = {
  default_provider: 'defaultProvider',
  default_model: 'defaultModel',
  plan_mode: 'planMode',
  default_permission_mode: 'defaultPermissionMode',
  default_plan_mode: 'defaultPlanMode',
  merge_all_available_skills: 'mergeAllAvailableSkills',
  extra_skill_dirs: 'extraSkillDirs',
  loop_control: 'loopControl',
};

registerSingleton(IConfigService, ConfigService, InstantiationType.Delayed);
