import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertSessionId,
  isSessionId,
  mergeSessionRecord,
  NodeBackend,
  SessionSpaceError,
  type SessionContainer,
  type SessionRecord,
  type SessionRecordDraft,
  type SessionSpace,
} from '@moonshot-ai/agent-core';

export function fsSessionSpace(root: string): SessionSpace {
  return new FsSessionSpace(root);
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
      if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
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
    await this.writeRecord(mergeSessionRecord(sessionId, undefined, record));
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
    const next = mergeSessionRecord(sessionId, await this.readRecord(sessionId), patch);
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
    await this.writeRecord(mergeSessionRecord(targetId, await this.readRecord(sourceId), undefined));
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
      return mergeSessionRecord(id, parsed, undefined);
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
