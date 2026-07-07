import { createDecorator } from '@moonshot-ai/agent-core';

/**
 * `IGuiStoreService` — a server-backed key/value store mirroring the browser
 * `localStorage` interface (`getItem` / `setItem` / `removeItem` / `clear` /
 * `length`). Values are opaque strings; callers (the web UI) handle their own
 * serialization. Persisted to `<homeDir>/gui.toml`.
 */
export interface IGuiStoreService {
  readonly _serviceBrand: undefined;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  length(): Promise<number>;
}

export const IGuiStoreService = createDecorator<IGuiStoreService>('guiStoreService');
