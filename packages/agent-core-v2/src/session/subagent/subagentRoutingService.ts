/**
 * `subagent` domain (L6) — `ISubagentRoutingService` implementation.
 *
 * Resolves the model alias and thinking effort for child agents spawned by the
 * `Agent` tool and the `swarm` domain. Resolution chain (highest wins): session
 * metadata override (`custom.subagentModelAlias` / `custom.subagentThinkingEffort`)
 * → `[subagent]` config default (`resolveDefaultSubagentModel` /
 * `resolveDefaultSubagentThinkingEffort`) → caller inheritance. Inert when the
 * `dual-model-routing` flag is off — all getters return `undefined`, so
 * `resolveChildModel` / `resolveChildThinkingEffort` fall back to the parent's
 * value. Session-scoped — one instance per session, caching the session-level
 * overrides loaded asynchronously from `ISessionMetadata`.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService } from '#/app/config/config';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { DUAL_MODEL_ROUTING_FLAG_ID } from './flag';
import {
  resolveDefaultSubagentModel,
  resolveDefaultSubagentThinkingEffort,
} from './configSection';
import { ISubagentRoutingService } from './subagentRouting';

export class SubagentRoutingService implements ISubagentRoutingService {
  declare readonly _serviceBrand: undefined;

  private overrideModel: string | undefined;
  private overrideThinkingEffort: string | undefined;
  readonly ready: Promise<void>;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    this.overrideModel = undefined;
    this.overrideThinkingEffort = undefined;
    this.ready = this.loadOverrides();
  }

  private async loadOverrides(): Promise<void> {
    const meta = await this.metadata.read();
    const custom = meta.custom;
    this.overrideModel = readStringOverride(custom?.['subagentModelAlias']);
    this.overrideThinkingEffort = readStringOverride(custom?.['subagentThinkingEffort']);
  }

  getSubagentModel(): string | undefined {
    if (!this.flags.enabled(DUAL_MODEL_ROUTING_FLAG_ID)) return undefined;
    return this.overrideModel ?? resolveDefaultSubagentModel(this.config) ?? undefined;
  }

  getSubagentThinkingEffort(): string | undefined {
    if (!this.flags.enabled(DUAL_MODEL_ROUTING_FLAG_ID)) return undefined;
    return (
      this.overrideThinkingEffort ?? resolveDefaultSubagentThinkingEffort(this.config) ?? undefined
    );
  }

  resolveChildModel(parentModelAlias: string): string {
    return this.getSubagentModel() ?? parentModelAlias;
  }

  resolveChildThinkingEffort(parentThinkingEffort: string): string {
    return this.getSubagentThinkingEffort() ?? parentThinkingEffort;
  }

  async setSubagentModel(alias: string | undefined): Promise<void> {
    const normalized = normalizeOverride(alias);
    this.overrideModel = normalized;
    const current = await this.metadata.read();
    await this.metadata.update({
      custom: { ...current.custom, subagentModelAlias: normalized },
    });
  }

  async setSubagentThinkingEffort(effort: string | undefined): Promise<void> {
    const normalized = normalizeOverride(effort);
    this.overrideThinkingEffort = normalized;
    const current = await this.metadata.read();
    await this.metadata.update({
      custom: { ...current.custom, subagentThinkingEffort: normalized },
    });
  }
}

function normalizeOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readStringOverride(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

registerScopedService(
  LifecycleScope.Session,
  ISubagentRoutingService,
  SubagentRoutingService,
  InstantiationType.Eager,
  'subagentRouting',
);
