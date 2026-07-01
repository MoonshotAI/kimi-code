/**
 * `IGuiStoreService` — server-backed key/value store mirroring browser localStorage.
 */

import { createDecorator } from '@moonshot-ai/agent-core-v2';

export interface IGuiStoreService {
  readonly _serviceBrand: undefined;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  length(): Promise<number>;
}

export const IGuiStoreService = createDecorator<IGuiStoreService>('guiStoreService');
