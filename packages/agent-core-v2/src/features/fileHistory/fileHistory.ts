import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface FileBackupEntry {
  readonly key: string | null;
  readonly version: number;
  readonly contentHash?: string;
  readonly size?: number;
  readonly oversize?: boolean;
  readonly mtimeMs?: number;
}

export type FileHistoryCheckpointPhase = 'start' | 'end';

export interface FileHistoryCheckpointRecord {
  readonly turnId: number;
  readonly phase?: FileHistoryCheckpointPhase;
  readonly entries: Readonly<Record<string, FileBackupEntry>>;
}

export interface FileHistoryState {
  readonly checkpoints: readonly FileHistoryCheckpointRecord[];
  readonly tracked: readonly string[];
}

export type FileHistoryChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileHistoryChange {
  readonly path: string;
  readonly status: FileHistoryChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: boolean;
  readonly oversize?: boolean;
}

export interface FileHistoryContent {
  readonly version: number;
  readonly content?: string;
  readonly binary?: boolean;
}

export interface IAgentFileHistoryService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;
  history(): FileHistoryState;
  settled(): Promise<void>;
  captureForActiveTurn(path: string): Promise<void>;
  changes(turnId: number): Promise<FileHistoryChange[]>;
  turnRecorded(turnId: number): Promise<boolean>;
  contentAt(
    turnId: number,
    path: string,
    phase?: FileHistoryCheckpointPhase,
  ): Promise<FileHistoryContent | undefined>;
}

export const IAgentFileHistoryService: ServiceIdentifier<IAgentFileHistoryService> =
  createDecorator<IAgentFileHistoryService>('agentFileHistoryService');

export const FILE_HISTORY_BLOB_PREFIX = 'file-history';
