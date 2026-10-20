import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { nodeBlobBackend } from '@moonshot-ai/agent-core/blob/backend/node';
import { openBlobStore } from '@moonshot-ai/agent-core/blob/index';
import {
  assertSessionId,
  isSessionId,
  mergeSessionRecord,
  SessionSpaceError,
  type SessionContainer,
  type SessionRecord,
  type SessionRecordDraft,
} from '@moonshot-ai/agent-core/session/index';
import { nodeJournal } from '@moonshot-ai/agent-core/store/backend/node';
import type { Journal } from '@moonshot-ai/agent-core/store/index';

import type { HarnessSessionSpace } from '#/runtime/index';

export function fsSessionSpace(root: string): HarnessSessionSpace {
  return new FsSessionSpace(root);
}

function lazyJournal(open: () => Promise<Journal>): Journal {
  let inner: Promise<Journal> | undefined;
  const ready = (): Promise<Journal> => (inner ??= open());
  return {
    names: async (prefix) => (await ready()).names(prefix),
    lines: async function* (log, from) {
      yield* (await ready()).lines(log, from);
    },
    append: async (log, seq, line) => (await ready()).append(log, seq, line),
    close: async () => {
      const opened = inner;
      inner = undefined;
      if (opened !== undefined) await (await opened).close();
    },
  };
}

class FsSessionSpace implements HarnessSessionSpace {
  private readonly featureJournals = new Map<string, Journal>();

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
    const now = new Date().toISOString();
    await this.writeRecord(
      mergeSessionRecord(sessionId, undefined, { createdAt: now, updatedAt: now, ...record }),
    );
    return this.container(sessionId);
  }

  async open(id: string): Promise<SessionContainer> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    return this.container(sessionId);
  }

  async update(id: string, patch: SessionRecordDraft): Promise<SessionRecord> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    const next = mergeSessionRecord(sessionId, await this.readRecord(sessionId), {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.writeRecord(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    const sessionId = assertSessionId(id);
    if (!(await this.has(sessionId))) {
      throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
    }
    const journal = this.featureJournals.get(sessionId);
    if (journal !== undefined) {
      this.featureJournals.delete(sessionId);
      await journal.close();
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
    await rm(join(this.dir(targetId), 'journal', 'writer.lock'), { force: true });
    await rm(join(this.dir(targetId), 'features', 'writer.lock'), { force: true });
    const now = new Date().toISOString();
    await this.writeRecord(
      mergeSessionRecord(targetId, await this.readRecord(sourceId), { createdAt: now, updatedAt: now }),
    );
    return this.container(targetId);
  }

  featureJournal(sessionId: string): Journal {
    assertSessionId(sessionId);
    let journal = this.featureJournals.get(sessionId);
    if (journal === undefined) {
      journal = lazyJournal(() => nodeJournal(join(this.dir(sessionId), 'features')));
      this.featureJournals.set(sessionId, journal);
    }
    return journal;
  }

  private dir(id: string): string {
    return join(this.root, id);
  }

  private async container(id: string): Promise<SessionContainer> {
    const dir = this.dir(id);
    return {
      journal: await nodeJournal(join(dir, 'journal')),
      blobs: openBlobStore(nodeBlobBackend(join(dir, 'blobs'))),
    };
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
      const parsed = JSON.parse(await readFile(join(this.dir(id), 'record.json'), 'utf8')) as SessionRecord;
      return mergeSessionRecord(id, parsed, undefined);
    } catch (error) {
      if (isEnoent(error)) return { id };
      throw error;
    }
  }

  private async writeRecord(record: SessionRecord): Promise<void> {
    const path = join(this.dir(record.id), 'record.json');
    await writeFile(`${path}.tmp`, JSON.stringify(record), 'utf8');
    await rename(`${path}.tmp`, path);
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
