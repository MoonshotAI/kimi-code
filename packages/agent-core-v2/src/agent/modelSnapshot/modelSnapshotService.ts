import { Disposable } from '#/_base/di/lifecycle';
import { isError2 } from '#/_base/errors/errors';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { type AssertExact, type Equal } from '#/_base/utils/typeEquality';
import { LifecycleScope } from '#/app/scopes';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { nonEmpty } from '#/kosong/model/modelAuth';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IProviderService } from '#/kosong/provider/provider';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentModelSnapshotService, type ModelSnapshotRecord } from './modelSnapshot';
import {
  ModelSnapshot,
  modelSnapshotsKey,
  type ModelSnapshotsState,
} from './modelSnapshotOps';

const SNAPSHOT_FIELD_NAMES = [
  'providerId',
  'baseUrl',
  'oauth',
  'protocol',
  'name',
  'aliases',
  'provider',
  'model',
  'maxContextSize',
  'maxInputSize',
  'maxOutputSize',
  'capabilities',
  'displayName',
  'reasoningKey',
  'adaptiveThinking',
  'betaApi',
  'supportEfforts',
  'defaultEffort',
  'offEffort',
  'overrides',
] as const;

type _AssertSnapshotFieldNames = AssertExact<
  Equal<(typeof SNAPSHOT_FIELD_NAMES)[number], keyof ModelSnapshotRecord>
>;

export class AgentModelSnapshotService extends Disposable implements IAgentModelSnapshotService {
  declare readonly _serviceBrand: undefined;

  private readonly fallbackWarnedAliases = new Set<string>();

  constructor(
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this.states.contributeState(modelSnapshotsKey);
  }

  resolve(alias: string): Model {
    try {
      const model = this.catalog.get(alias);
      this.refreshSnapshot(alias);
      return model;
    } catch (error) {
      return this.resolveFromSnapshot(alias, error, (record) =>
        this.catalog.getFromRecord(alias, record),
      );
    }
  }

  resolveRequester(alias: string): ModelRequester {
    try {
      const requester = this.catalog.getRequester(alias);
      this.refreshSnapshot(alias);
      return requester;
    } catch (error) {
      return this.resolveFromSnapshot(alias, error, (record) =>
        this.catalog.getRequesterFromRecord(alias, record),
      );
    }
  }

  private get snapshots(): ModelSnapshotsState {
    return this.states.get(modelSnapshotsKey) as ModelSnapshotsState;
  }

  private refreshSnapshot(alias: string): void {
    const record = this.models.get(alias);
    if (record === undefined) return;
    if (nonEmpty(record.apiKey) !== undefined) return;
    const snapshot = toSnapshotRecord(record);
    if (snapshot.providerId === undefined && snapshot.provider === undefined) {
      const defaultProvider = this.providers.getDefaultProvider();
      if (defaultProvider !== undefined) snapshot.provider = defaultProvider;
    }
    const existing = this.snapshots[alias];
    if (existing !== undefined && snapshotRecordsEqual(existing, snapshot)) return;
    void this.dispatcher.dispatch(new ModelSnapshot({ alias, record: snapshot }));
  }

  private resolveFromSnapshot<T>(
    alias: string,
    error: unknown,
    build: (record: ModelSnapshotRecord) => T,
  ): T {
    if (!isError2(error) || error.code !== CONFIG_INVALID_ERROR_CODE) throw error;
    if (this.models.get(alias) !== undefined) throw error;
    const snapshot = this.snapshots[alias];
    if (snapshot === undefined) throw error;
    const providerId = snapshot.providerId ?? snapshot.provider;
    if (providerId !== undefined && this.providers.get(providerId) === undefined) throw error;
    const resolved = build(snapshot);
    this.warnOnce(alias);
    return resolved;
  }

  private warnOnce(alias: string): void {
    if (this.fallbackWarnedAliases.has(alias)) return;
    this.fallbackWarnedAliases.add(alias);
    void this.dispatcher.dispatch(
      new WarningIssued({
        code: 'model-snapshot-fallback',
        message: `Model "${alias}" is no longer configured in config.toml; this session continues with the last resolved configuration for it.`,
      }),
    );
  }
}

function toSnapshotRecord(record: ModelRecord): ModelSnapshotRecord {
  const out: Record<string, unknown> = {};
  for (const key of SNAPSHOT_FIELD_NAMES) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = structuredClone(value);
  }
  return out as ModelSnapshotRecord;
}

function snapshotRecordsEqual(a: ModelSnapshotRecord, b: ModelSnapshotRecord): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentModelSnapshotService,
  AgentModelSnapshotService,
  ScopeActivation.OnScopeCreated,
  'modelSnapshot',
);
