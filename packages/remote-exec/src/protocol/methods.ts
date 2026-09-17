export const INITIALIZE_METHOD = 'initialize';
export const INITIALIZED_METHOD = 'initialized';
export const ENVIRONMENT_STATUS_METHOD = 'environment/status';

export const FS_READ_FILE_METHOD = 'fs/readFile';
export const FS_WRITE_FILE_METHOD = 'fs/writeFile';
export const FS_CREATE_DIRECTORY_METHOD = 'fs/createDirectory';
export const FS_GET_METADATA_METHOD = 'fs/getMetadata';
export const FS_CANONICALIZE_METHOD = 'fs/canonicalize';
export const FS_READ_DIRECTORY_METHOD = 'fs/readDirectory';
export const FS_REMOVE_METHOD = 'fs/remove';
export const FS_RENAME_METHOD = 'fs/rename';

export const PROCESS_START_METHOD = 'process/start';
export const PROCESS_OUTPUT_METHOD = 'process/output';
export const PROCESS_EXITED_METHOD = 'process/exited';
export const PROCESS_CLOSED_METHOD = 'process/closed';
export const PROCESS_READ_METHOD = 'process/read';
export const PROCESS_WRITE_METHOD = 'process/write';
export const PROCESS_SIGNAL_METHOD = 'process/signal';
export const PROCESS_TERMINATE_METHOD = 'process/terminate';
export const PROCESS_RESIZE_METHOD = 'process/resize';

export const SERVER_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  PROCESS_OUTPUT_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_CLOSED_METHOD,
]);

// Client→server request methods that are intentionally unbounded: process/read
// long-polls server-side until output arrives or waitMs elapses, so a per-call
// timeout would kill healthy polling. (Terminal streams ride server→client
// notifications, not calls.) Every other request method is control-plane and
// gets the client's bounded call timeout.
export const LONG_POLL_METHODS: ReadonlySet<string> = new Set([PROCESS_READ_METHOD]);

export interface InitializeParams {
  readonly clientName: string;
  readonly clientVersion: string;
}

export interface RemoteEnvironmentInfo {
  readonly osKind: string;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: string;
  readonly shellPath: string;
  readonly pathClass: string;
  readonly homeDir: string;
  readonly cwd: string;
  readonly tempDir: string;
}

export type RemoteCapabilities = Record<string, boolean>;

export interface InitializeResult {
  readonly executorVersion: string;
  readonly environment: RemoteEnvironmentInfo;
  readonly capabilities: RemoteCapabilities;
}

export interface EnvironmentStatusResult {
  readonly status: 'ready';
}

export interface FsReadFileParams {
  readonly path: string;
  readonly offset?: number;
  readonly maxBytes?: number;
  readonly followSymlinks?: boolean;
}

export interface FsReadFileResult {
  readonly dataBase64: string;
  readonly eof: boolean;
}

export type FsWriteMode = 'truncate' | 'append' | 'exclusive';

export interface FsWriteFileParams {
  readonly path: string;
  readonly dataBase64: string;
  readonly mode: FsWriteMode;
  readonly followSymlinks?: boolean;
}

export interface FsCreateDirectoryParams {
  readonly path: string;
  readonly recursive?: boolean;
}

export interface FsGetMetadataParams {
  readonly path: string;
  readonly followSymlinks?: boolean;
}

export interface FsGetMetadataResult {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly size: number;
  readonly createdAtMs: number;
  readonly modifiedAtMs: number;
}

export interface FsCanonicalizeParams {
  readonly path: string;
}

export interface FsCanonicalizeResult {
  readonly path: string;
}

export interface FsReadDirectoryParams {
  readonly path: string;
}

export interface FsReadDirectoryEntry {
  readonly fileName: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

export interface FsReadDirectoryResult {
  readonly entries: FsReadDirectoryEntry[];
}

export interface FsRemoveParams {
  readonly path: string;
  readonly recursive?: boolean;
  readonly force?: boolean;
}

export interface FsRenameParams {
  readonly from: string;
  readonly to: string;
}

export interface ProcessStartParams {
  readonly processId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly tty?: boolean;
  readonly pipeStdin?: boolean;
  readonly arg0?: string;
}

export interface ProcessStartResult {
  readonly processId: string;
  readonly pid: number;
}

export type ProcessOutputStream = 'stdout' | 'stderr' | 'pty';

export interface ProcessOutputNotification {
  readonly processId: string;
  readonly seq: number;
  readonly stream: ProcessOutputStream;
  readonly chunkBase64: string;
}

export interface ProcessExitedNotification {
  readonly processId: string;
  readonly seq: number;
  readonly exitCode: number;
}

export interface ProcessClosedNotification {
  readonly processId: string;
  readonly seq: number;
}

export interface ProcessReadParams {
  readonly processId: string;
  readonly afterSeq?: number;
  readonly maxBytes?: number;
  readonly waitMs?: number;
}

export interface ProcessReadChunk {
  readonly seq: number;
  readonly stream: ProcessOutputStream;
  readonly chunkBase64: string;
}

export interface ProcessReadResult {
  readonly chunks: ProcessReadChunk[];
  readonly nextSeq: number;
  readonly exited: boolean;
  readonly exitCode?: number;
  readonly closed: boolean;
}

export interface ProcessWriteParams {
  readonly processId: string;
  readonly chunkBase64: string;
  readonly writeId: string;
  readonly eof?: boolean;
}

export type ProcessWriteStatus = 'accepted' | 'unknownProcess' | 'stdinClosed' | 'starting';

export interface ProcessWriteResult {
  readonly status: ProcessWriteStatus;
}

export type ProcessSignalKind = 'interrupt' | 'terminate' | 'kill';

export interface ProcessSignalParams {
  readonly processId: string;
  readonly signal: ProcessSignalKind;
}

export interface ProcessTerminateParams {
  readonly processId: string;
}

export interface ProcessTerminateResult {
  readonly running: boolean;
}

export interface ProcessResizeParams {
  readonly processId: string;
  readonly cols: number;
  readonly rows: number;
}

export const MIN_EXECUTOR_VERSION = '0.1.0';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export const FS_READ_FILE_MAX_BYTES = 1024 * 1024;
export const FS_READ_FILE_WHOLE_MAX_BYTES = 32 * 1024 * 1024;
export const FS_READ_DIRECTORY_MAX_ENTRIES = 50_000;
export const PROCESS_REPLAY_MAX_BYTES = 1024 * 1024;
export const PROCESS_REPLAY_MAX_CHUNKS = 50_000;
export const PROCESS_WRITE_ID_CACHE_SIZE = 4096;
export const PROCESS_EXITED_RETENTION_MS = 30_000;
export const MAX_IN_FLIGHT_CALLS = 256;
export const MAX_PENDING_SEND_BYTES = 64 * 1024 * 1024;
