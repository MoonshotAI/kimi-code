export interface ToolStoreData {}

export type ToolStoreKey = Extract<keyof ToolStoreData, string>;

export interface ToolStore {
  get<K extends ToolStoreKey>(key: K): ToolStoreData[K] | undefined;
  set<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void;
}

export interface ToolStoreUpdate<K extends ToolStoreKey = ToolStoreKey> {
  readonly key: K;
  readonly value: ToolStoreData[K];
}
