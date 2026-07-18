// bench/session-store.ts
//
// Schema + query layer for the kimi-code session store, built on minidb.
//
// Two logical "tables" via key prefixes in one db:
//   ws:<workspaceId>    -> WorkspaceDoc
//   sess:<sessionId>    -> SessionDoc
//
// Indexes on the session docs:
//   byWorkspace (equality, workspaceId)  -> list sessions in a workspace
//   byWorkDir   (equality, workDir)      -> list sessions for a cwd
//   body        (full-text on `text`)    -> fuzzy search title/tool_call/content
//   dt.updatedAt / dt.createdAt          -> time-ordered listing + range
//
// The full wire.jsonl is NOT stored (it's large and is the source of truth on
// disk); we store its path plus the extracted searchable text.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

export interface WorkspaceDoc {
  name: string;
  root: string;
}

export interface SessionDoc {
  workspaceId: string;
  workspaceName: string;
  workDir: string;
  title: string;
  lastPrompt: string;
  text: string; // title + messages + tool_call intents (searchable)
  sessionDir: string;
  messageCount: number;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface SessionHit extends SessionDoc {
  sessionId: string;
  updatedAt?: number;
  createdAt?: number;
}

const ARG_FIELDS = ['command', 'pattern', 'path', 'description', 'query', 'prompt', 'file_path'];

function extractWireText(wirePath: string): { text: string; messages: number } {
  let raw: string;
  try {
    raw = readFileSync(wirePath, 'utf8');
  } catch {
    return { text: '', messages: 0 };
  }
  const parts: string[] = [];
  let messages = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: { type?: string; message?: { content?: { type?: string; text?: string }[] }; event?: { type?: string; name?: string; args?: Record<string, unknown> } };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    if (o.type === 'context.append_message' && o.message?.content) {
      let got = false;
      for (const c of o.message.content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
          got = true;
        }
      }
      if (got) messages++;
    } else if (o.type === 'context.append_loop_event' && o.event?.type === 'tool.call') {
      const e = o.event;
      const bits = [e.name ?? ''];
      for (const k of ARG_FIELDS) {
        const v = e.args?.[k];
        if (typeof v === 'string' && v) bits.push(v.length > 2000 ? v.slice(0, 2000) : v);
      }
      parts.push(bits.join(' '));
    }
  }
  return { text: parts.join('\n'), messages };
}

export class SessionStore {
  private constructor(public db: MiniDb<unknown>) {}

  static async open(dir: string): Promise<SessionStore> {
    const db = await MiniDb.open({ dir, valueCodec: 'json', onLockFail: 'readonly' });
    // create indexes idempotently (ignore "already exists")
    for (const mk of [
      () => db.createIndex('byWorkspace', { field: 'workspaceId' }),
      () => db.createIndex('byWorkDir', { field: 'workDir' }),
      () => db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' }),
      () => db.createCompoundIndex('byWsCreated', { groupBy: 'workspaceId', orderBy: 'createdAt' }),
      () => db.createTextIndex('body', { fields: ['text'] }),
    ]) {
      try {
        await mk();
      } catch {
        /* already exists */
      }
    }
    return new SessionStore(db);
  }

  // ---- ingest -------------------------------------------------------------

  async ingestKimiCode(homeDir: string): Promise<{ workspaces: number; sessions: number; textBytes: number }> {
    const wsRaw = JSON.parse(readFileSync(path.join(homeDir, 'workspaces.json'), 'utf8')) as {
      workspaces?: Record<string, { name: string; root: string; created_at?: string; last_opened_at?: string }>;
    };
    const workspaces = wsRaw.workspaces ?? {};
    const lines = readFileSync(path.join(homeDir, 'session_index.jsonl'), 'utf8').trim().split('\n');

    let wsCount = 0;
    let sessCount = 0;
    let textBytes = 0;
    const batch: { op: 'set'; key: string; value: unknown; dt?: Record<string, number> }[] = [];

    // workspaces
    for (const [id, ws] of Object.entries(workspaces)) {
      batch.push({
        op: 'set',
        key: 'ws:' + id,
        value: { name: ws.name, root: ws.root } satisfies WorkspaceDoc,
        dt: {
          lastOpenedAt: ws.last_opened_at ? Date.parse(ws.last_opened_at) : 0,
          createdAt: ws.created_at ? Date.parse(ws.created_at) : 0,
        },
      });
      wsCount++;
    }

    // sessions
    for (const line of lines) {
      let meta: { sessionId: string; sessionDir: string; workDir: string };
      try {
        meta = JSON.parse(line) as typeof meta;
      } catch {
        continue;
      }
      const wirePath = path.join(meta.sessionDir, 'agents', 'main', 'wire.jsonl');
      if (!existsSync(wirePath)) continue;

      let state: { title?: string; lastPrompt?: string; createdAt?: string; updatedAt?: string } = {};
      try {
        state = JSON.parse(readFileSync(path.join(meta.sessionDir, 'state.json'), 'utf8')) as typeof state;
      } catch {
        /* no state.json */
      }

      const { text, messages } = extractWireText(wirePath);
      const wsId = path.basename(path.dirname(meta.sessionDir));
      const ws = workspaces[wsId];
      const doc: SessionDoc = {
        workspaceId: wsId,
        workspaceName: ws?.name ?? '',
        workDir: meta.workDir,
        title: state.title ?? '',
        lastPrompt: state.lastPrompt ?? '',
        text: (state.title ? state.title + '\n' : '') + text,
        sessionDir: meta.sessionDir,
        messageCount: messages,
      };
      textBytes += Buffer.byteLength(doc.text, 'utf8');
      batch.push({
        op: 'set',
        key: 'sess:' + meta.sessionId,
        value: doc,
        dt: {
          updatedAt: state.updatedAt ? Date.parse(state.updatedAt) : 0,
          createdAt: state.createdAt ? Date.parse(state.createdAt) : 0,
        },
      });
      sessCount++;
    }

    // chunk the batch into reasonable groups
    const CHUNK = 500;
    for (let i = 0; i < batch.length; i += CHUNK) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.db.batch(batch.slice(i, i + CHUNK) as any);
    }
    return { workspaces: wsCount, sessions: sessCount, textBytes };
  }

  // ---- 1. list workspaces (paginated, by lastOpenedAt desc) ---------------

  listWorkspaces({ limit = 20, offset = 0 }: { limit?: number; offset?: number } = {}): Page<WorkspaceDoc & { id: string }> {
    const all = this.db
      .prefix('ws:')
      .map((r) => ({ id: r.key.slice(3), ...(r.value as WorkspaceDoc), dt: r.dt }));
    all.sort((a, b) => (b.dt?.lastOpenedAt ?? 0) - (a.dt?.lastOpenedAt ?? 0));
    const items = all.slice(offset, offset + limit).map(({ id, name, root }) => ({ id, name, root }));
    return { items, hasMore: offset + limit < all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
  }

  // ---- 2. list sessions in a workspace (paginated, by updatedAt desc) -----

  listSessions(workspaceId: string, { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {}): Page<SessionHit> {
    // O(log N + limit): the compound index is already ordered by updatedAt.
    const page = this.db.compoundRange('byWsUpdated', workspaceId, { reverse: true, offset, limit });
    const items: SessionHit[] = [];
    for (const r of page) {
      const rec = this.db.getRecord(r.key);
      items.push({
        sessionId: r.key.slice(5),
        ...(r.value as SessionDoc),
        updatedAt: rec?.dt?.updatedAt,
        createdAt: rec?.dt?.createdAt,
      });
    }
    // hasMore: peek one more
    const peek = this.db.compoundRange('byWsUpdated', workspaceId, { reverse: true, offset: offset + limit, limit: 1 });
    return { items, hasMore: peek.length > 0, nextOffset: peek.length > 0 ? offset + limit : null };
  }

  // ---- 3. precise get session + metadata + wire path + time ---------------

  getSession(sessionId: string): (SessionHit & { wirePath: string }) | null {
    const rec = this.db.getRecord('sess:' + sessionId);
    if (!rec) return null;
    const doc = rec.value as SessionDoc;
    return {
      sessionId,
      ...doc,
      updatedAt: rec.dt?.updatedAt,
      createdAt: rec.dt?.createdAt,
      wirePath: path.join(doc.sessionDir, 'agents', 'main', 'wire.jsonl'),
    };
  }

  readWire(sessionId: string): string | null {
    const s = this.getSession(sessionId);
    if (!s) return null;
    try {
      return readFileSync(s.wirePath, 'utf8');
    } catch {
      return null;
    }
  }

  // ---- 4. fuzzy search title / tool_call / content ------------------------

  search(q: string, { workspaceId, limit = 20 }: { workspaceId?: string; limit?: number } = {}): (SessionHit & { score: number })[] {
    if (workspaceId) {
      // text search intersected with workspace filter, ordered by updatedAt
      return this.db
        .query({
          text: { index: 'body', q },
          filter: { workspaceId },
          sort: { updatedAt: -1 },
          limit,
        })
        .map((r) => ({ sessionId: r.key.slice(5), ...(r.value as SessionDoc), updatedAt: r.dt?.updatedAt, createdAt: r.dt?.createdAt, score: 0 }));
    }
    return this.db.search('body', q, { limit }).map((r) => {
      const rec = this.db.getRecord(r.key);
      return {
        sessionId: r.key.slice(5),
        ...(r.value as SessionDoc),
        updatedAt: rec?.dt?.updatedAt,
        createdAt: rec?.dt?.createdAt,
        score: r.score,
      };
    });
  }
}
