import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MemoryBackend, NodeBackend, type SessionContainer } from '@moonshot-ai/agent-core';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function fsSessionSpace(root: string): SessionSpace {
  return new FsSessionSpace(root);
}

function assertSessionId(id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionSpaceError('invalid-id', `invalid session id '${id}'`);
  }
  return id;
}

function mergeRecord(id: string, current: SessionRecordDraft | undefined, patch: SessionRecordDraft | undefined): SessionRecord {
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
    this.entries.set(sessionId, { record: mergeRecord(sessionId, undefined, record), backend });
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
    entry.record = mergeRecord(sessionId, entry.record, patch);
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
      record: mergeRecord(targetId, source.record, undefined),
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

class FsSessionSpace implements SessionSpace {
  constructor(private readonly root: string) {}

  async list(): Promise<readonly SessionRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    const records: SessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
      records.push(await this.readRecord(entry.name));
    }
    return records;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) return undefined;
    return this.readRecord(sessionId);
  }

  async create(id: string, record?: SessionRecordDraft): Promise<SessionContainer> {
    const sessionId = assertSessionId(id);
    if (await this.has(sessionId)) {
      throw new SessionSpaceError('already-exists', `session '${sessionId}' already exists`);
    }
    await mkdir(this.dir(sessionId), { recursive: true });
    await this.writeRecord(mergeRecord(sessionId, undefined, record));
    return new NodeBackend(this.dir(sessionId));
  }

  async open(id: string): Promise<SessionContainer> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    return new NodeBackend(this.dir(sessionId));
  }

  async update(id: string, patch: SessionRecordDraft): Promise<SessionRecord> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    const next = mergeRecord(sessionId, await this.readRecord(sessionId), patch);
    await this.writeRecord(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    await rm(this.dir(sessionId), { recursive: true, force: true });
  }

  async copy(from: string, to: string): Promise<SessionContainer> {
    const sourceId = assertSessionId(from);
    const targetId = assertSessionId(to);
    if (!(await this.has(sourceId))) {
      throw new SessionSpaceError('not-found', `session '${sourceId}' does not exist`);
    }
    if (await this.has(targetId)) {
      throw new SessionSpaceError('already-exists', `session '${targetId}' already exists`);
    }
    await mkdir(this.root, { recursive: true });
    await cp(this.dir(sourceId), this.dir(targetId), { recursive: true });
    await this.writeRecord(mergeRecord(targetId, await this.readRecord(sourceId), undefined));
    return new NodeBackend(this.dir(targetId));
  }

  private dir(id: string): string {
    return join(this.root, id);
  }

  private async has(id: string): Promise<boolean> {
    try {
      return (await stat(this.dir(id))).isDirectory();
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private async readRecord(id: string): Promise<SessionRecord> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir(id), 'meta.json'), 'utf8')) as SessionRecord;
      return mergeRecord(id, parsed, undefined);
    } catch (error) {
      if (isEnoent(error)) return { id };
      throw error;
    }
  }

  private async writeRecord(record: SessionRecord): Promise<void> {
    const path = join(this.dir(record.id), 'meta.json');
    await writeFile(`${path}.tmp`, JSON.stringify(record), 'utf8');
    await rename(`${path}.tmp`, path);
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
