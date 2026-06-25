import { createDecorator } from "#/_base/di";
import type { ToolStore, ToolStoreData, ToolStoreKey } from '../../../tools/store';
import type { Hooks } from '../hooks';

export interface IToolStoreService extends ToolStore {
  data(): Readonly<Partial<ToolStoreData>>;

  readonly hooks: Hooks<{
    onUpdated: { key: ToolStoreKey; value: ToolStoreData[ToolStoreKey] };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolStoreService = createDecorator<IToolStoreService>('agentToolStoreService');
