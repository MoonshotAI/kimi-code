import { createDecorator, type IDisposable } from '@moonshot-ai/agent-core-v2';

export interface GuiStoreEntry {
  readonly value: string;
  readonly revision: number;
}

export interface GuiStoreSnapshot {
  readonly revision: number;
  readonly entries: Record<string, GuiStoreEntry>;
}

export interface GuiStoreQuery {
  readonly prefix?: string;
  readonly keys?: readonly string[];
}

export interface GuiStoreMutation {
  readonly key: string;
  readonly value: string | null;
  readonly ifRevision?: number;
}

export interface GuiStorePatchResult {
  readonly applied: boolean;
  readonly revision: number;
  readonly entries: Record<string, GuiStoreEntry | null>;
  readonly conflicts: Record<string, GuiStoreEntry | null>;
}

export interface GuiStoreChangeEvent {
  readonly revision: number;
  readonly entries: Record<string, GuiStoreEntry | null>;
}

export interface IGuiStoreService {
  readonly _serviceBrand: undefined;
  getSnapshot(query?: GuiStoreQuery): Promise<GuiStoreSnapshot>;
  patch(mutations: readonly GuiStoreMutation[]): Promise<GuiStorePatchResult>;
  onDidChange(listener: (event: GuiStoreChangeEvent) => void): IDisposable;
  close(): Promise<void>;
}

export const IGuiStoreService = createDecorator<IGuiStoreService>('guiStoreService');

export { GuiStoreCorruptError, GuiStorePersistenceError } from './guiStoreService';
