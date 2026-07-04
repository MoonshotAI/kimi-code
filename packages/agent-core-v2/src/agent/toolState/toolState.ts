import { createDecorator } from "#/_base/di";
import type { Hooks } from '#/hooks';

export interface ToolStoreData { }

export type ToolStoreKey = Extract<keyof ToolStoreData, string>;

export interface ToolStore {
  get<K extends ToolStoreKey>(key: K): ToolStoreData[K] | undefined;
  set<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void;
}

export interface ToolStoreUpdate<K extends ToolStoreKey = ToolStoreKey> {
  readonly key: K;
  readonly value: ToolStoreData[K];
}

export interface IAgentToolState extends ToolStore {
  readonly _serviceBrand: undefined;

  data(): Readonly<Partial<ToolStoreData>>;

  readonly hooks: Hooks<{
    onUpdated: { key: ToolStoreKey; value: ToolStoreData[ToolStoreKey] };
  }>;
}

export const IAgentToolState = createDecorator<IAgentToolState>('agentToolState');
