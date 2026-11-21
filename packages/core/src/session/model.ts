export type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

export interface SessionRecord {
  readonly id: string;
  readonly version?: number;
  readonly title?: string;
  readonly titleKind?: SessionTitleKind;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, unknown>>;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export type SessionInit<T extends SessionRecord> = Omit<T, 'createdAt' | 'updatedAt'> & {
  readonly createdAt?: number;
  readonly updatedAt?: number;
};

export type SessionPatch<T extends SessionRecord> = Partial<Omit<T, 'id' | 'createdAt'>>;

export interface SessionUpdateOptions {
  readonly touchUpdatedAt?: boolean;
}

export interface SessionSpace<T extends SessionRecord = SessionRecord> {
  list(prefix?: string): Promise<readonly string[]>;
  get(key: string): Promise<T | undefined>;
  create(key: string, init: SessionInit<T>): Promise<T>;
  update(key: string, patch: SessionPatch<T>, opts?: SessionUpdateOptions): Promise<T>;
  delete(key: string): Promise<void>;
}

export interface SessionSpaceBackend<T extends SessionRecord = SessionRecord> {
  list(prefix?: string): Promise<readonly string[]>;
  read(key: string): Promise<T | undefined>;
  write(key: string, record: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type SessionSpaceErrorReason = 'invalid-key' | 'not-found' | 'already-exists';

export class SessionSpaceError extends Error {
  constructor(readonly reason: SessionSpaceErrorReason, message: string) {
    super(message);
    this.name = 'SessionSpaceError';
  }
}
