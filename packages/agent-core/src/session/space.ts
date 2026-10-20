import { memoryBlobBackend } from '#/blob/backend/memory';
import { openBlobStore, type BlobStore } from '#/blob/index';
import { memoryJournal } from '#/store/backend/memory';
import type { Journal } from '#/store/index';

import type { LastTurn } from './session';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SessionRecord {
  readonly id: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly lastTurn?: LastTurn;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type SessionRecordDraft = Omit<SessionRecord, 'id'>;

export interface SessionContainer {
  readonly journal: Journal;
  readonly blobs: BlobStore;
}

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
  const metadata =
    patch?.metadata !== undefined
      ? { ...current?.metadata, ...patch.metadata }
      : current?.metadata;
  const lastTurn = patch !== undefined && 'lastTurn' in patch ? patch.lastTurn : current?.lastTurn;
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(lastTurn !== undefined ? { lastTurn } : {}),
    createdAt: patch?.createdAt ?? current?.createdAt,
    updatedAt: patch?.updatedAt ?? current?.updatedAt,
  };
}

interface MemoryEntry {
  record: SessionRecord;
  logs: Map<string, string[]>;
  blobs: Map<string, Uint8Array>;
}

function containerOf(entry: MemoryEntry): SessionContainer {
  return {
    journal: memoryJournal(entry.logs),
    blobs: openBlobStore(memoryBlobBackend(entry.blobs)),
  };
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
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      record: mergeSessionRecord(sessionId, undefined, { createdAt: now, updatedAt: now, ...record }),
      logs: new Map(),
      blobs: new Map(),
    };
    this.entries.set(sessionId, entry);
    return containerOf(entry);
  }

  async open(id: string): Promise<SessionContainer> {
    const entry = this.entries.get(assertSessionId(id));
    if (entry === undefined) {
      throw new SessionSpaceError('not-found', `session '${id}' does not exist`);
    }
    return containerOf(entry);
  }

  async update(id: string, patch: SessionRecordDraft): Promise<SessionRecord> {
    const entry = this.entries.get(assertSessionId(id));
    if (entry === undefined) {
      throw new SessionSpaceError('not-found', `session '${id}' does not exist`);
    }
    entry.record = mergeSessionRecord(id, entry.record, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return entry.record;
  }

  async delete(id: string): Promise<void> {
    if (!this.entries.delete(assertSessionId(id))) {
      throw new SessionSpaceError('not-found', `session '${id}' does not exist`);
    }
  }

  async copy(from: string, to: string): Promise<SessionContainer> {
    const source = this.entries.get(assertSessionId(from));
    if (source === undefined) {
      throw new SessionSpaceError('not-found', `session '${from}' does not exist`);
    }
    const targetId = assertSessionId(to);
    if (this.entries.has(targetId)) {
      throw new SessionSpaceError('already-exists', `session '${targetId}' already exists`);
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      record: mergeSessionRecord(targetId, source.record, { createdAt: now, updatedAt: now }),
      logs: new Map([...source.logs].map(([name, lines]) => [name, lines.slice()])),
      blobs: new Map([...source.blobs].map(([key, bytes]) => [key, bytes.slice()])),
    };
    this.entries.set(targetId, entry);
    return containerOf(entry);
  }
}
