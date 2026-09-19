import { MemoryBackend } from '#/store/tree';
import type { SessionContainer } from '#/stores/session';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SessionRecord {
  readonly id: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly metadata?: Record<string, unknown>;
}

export type SessionRecordDraft = Omit<SessionRecord, 'id'>;

export interface SessionSpace {
  list(): Promise<readonly SessionRecord[]>;
  get(id: string): Promise<SessionRecord | undefined>;
  create(id: string, record?: SessionRecordDraft): Promise<SessionContainer>;
  open(id: string): Promise<SessionContainer>;
  update(id: string, patch: SessionRecordDraft): Promise<SessionRecord>;
  delete(id: string): Promise<void>;
  copy(from: string, to: string): Promise<SessionContainer>;
}

export type SessionSpaceErrorReason = 'invalid-id' | 'not-found' | 'already-exists';

export class SessionSpaceError extends Error {
  readonly reason: SessionSpaceErrorReason;

  constructor(reason: SessionSpaceErrorReason, message: string) {
    super(message);
    this.name = 'SessionSpaceError';
    this.reason = reason;
  }
}

export function memorySessionSpace(): SessionSpace {
  return new MemorySessionSpace();
}

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function assertSessionId(id: string): string {
  if (!isSessionId(id)) {
    throw new SessionSpaceError('invalid-id', `invalid session id '${id}'`);
  }
  return id;
}

export function mergeSessionRecord(
  id: string,
  current: SessionRecordDraft | undefined,
  patch: SessionRecordDraft | undefined,
): SessionRecord {
  const title = patch?.title ?? current?.title;
  const workspaceId = patch?.workspaceId ?? current?.workspaceId;
  const metadata = patch?.metadata ?? current?.metadata;
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

interface MemoryEntry {
  record: SessionRecord;
  backend: MemoryBackend;
}

class MemorySessionSpace implements SessionSpace {
  private readonly entries = new Map<string, MemoryEntry>();

  async list(): Promise<readonly SessionRecord[]> {
    return [...this.entries.values()].map((entry) => entry.record);
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    return this.entries.get(assertSessionId(id))?.record;
  }

  async create(id: string, record?: SessionRecordDraft): Promise<SessionContainer> {
    const sessionId = assertSessionId(id);
    if (this.entries.has(sessionId)) {
      throw new SessionSpaceError('already-exists', `session '${sessionId}' already exists`);
    }
    const backend = new MemoryBackend();
    this.entries.set(sessionId, { record: mergeSessionRecord(sessionId, undefined, record), backend });
    return backend;
  }

  async open(id: string): Promise<SessionContainer> {
    const sessionId = assertSessionId(id);
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    return entry.backend;
  }

  async update(id: string, patch: SessionRecordDraft): Promise<SessionRecord> {
    const sessionId = assertSessionId(id);
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    entry.record = mergeSessionRecord(sessionId, entry.record, patch);
    return entry.record;
  }

  async delete(id: string): Promise<void> {
    const sessionId = assertSessionId(id);
    if (!this.entries.delete(sessionId)) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
  }

  async copy(from: string, to: string): Promise<SessionContainer> {
    const sourceId = assertSessionId(from);
    const targetId = assertSessionId(to);
    const source = this.entries.get(sourceId);
    if (source === undefined) {
      throw new SessionSpaceError('not-found', `session '${sourceId}' does not exist`);
    }
    if (this.entries.has(targetId)) {
      throw new SessionSpaceError('already-exists', `session '${targetId}' already exists`);
    }
    const backend = cloneMemoryBackend(source.backend);
    this.entries.set(targetId, {
      record: mergeSessionRecord(targetId, source.record, undefined),
      backend,
    });
    return backend;
  }
}

function cloneMemoryBackend(source: MemoryBackend): MemoryBackend {
  const cloned = new MemoryBackend();
  for (const [tree, branches] of source.trees.files) {
    cloned.trees.files.set(tree, new Map(branches));
  }
  for (const [ref, bytes] of source.blobs.files) {
    cloned.blobs.files.set(ref, bytes.slice());
  }
  return cloned;
}
