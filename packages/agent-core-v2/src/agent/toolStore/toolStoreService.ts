import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { OrderedHookSlot } from '#/hooks';
import { IAgentToolStoreService, type ToolStoreData, type ToolStoreKey } from './toolStore';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'tools.update_store': {
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
    };
  }
}

export class AgentToolStoreService extends Disposable implements IAgentToolStoreService {
  declare readonly _serviceBrand: undefined;
  private readonly store: Partial<ToolStoreData> = {};

  readonly hooks = {
    onUpdated: new OrderedHookSlot<{
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
    }>(),
  };

  constructor(@IAgentRecordService private readonly records: IAgentRecordService) {
    super();
    this._register(
      records.define('tools.update_store', {
        resume: (r) => {
          this.apply(r.key, r.value);
        },
      }),
    );
  }

  get<K extends ToolStoreKey>(key: K): ToolStoreData[K] | undefined {
    return this.store[key];
  }

  set<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    const record: AgentRecord<'tools.update_store'> = {
      type: 'tools.update_store',
      key,
      value,
    };
    this.records.append(record);
    this.apply(key, value);
  }

  data(): Readonly<Partial<ToolStoreData>> {
    return { ...this.store };
  }

  private apply<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    this.store[key] = value;
    if (!this.records.restoring) {
      void this.hooks.onUpdated.run({ key, value });
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolStoreService,
  AgentToolStoreService,
  InstantiationType.Delayed,
  'toolStore',
);
