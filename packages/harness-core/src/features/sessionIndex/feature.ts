import { mkdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { dirname } from 'pathe';

import {
  createFacadeToken,
  createFeature,
  MAIN_AGENT_ID,
  useApp,
  useCleanup,
  useOnApp,
  type FeatureSpec,
  type SessionRecord,
} from '@moonshot-ai/agent-core';
import { useExpose, useReady } from '@moonshot-ai/agent-core/kernel/index';

import { sessionWorkspaceId } from '#/features/workspaces/index';

import {
  listAllSummaries,
  listSummaries,
  listWorkspaceGroups,
  type SessionGroupPage,
  type SessionIndexFilterQuery,
  type SessionIndexGroupQuery,
  type SessionIndexQuery,
  type SessionSummaryPage,
} from './query';
import {
  migrateSessionIndex,
  toSummaryRow,
  type RawSummaryRow,
  type SessionSummaryRow,
} from './schema';
import { scanSessionDir } from './scan';

export interface CreateSessionIndexProps {
  readonly dbPath: string;
  readonly sessionDir?: (sessionId: string) => string;
  readonly now?: () => number;
}

export interface SessionIndexFace {
  get(id: string): SessionSummaryRow | undefined;
  list(query?: SessionIndexQuery): SessionSummaryPage;
  listByWorkspace(query?: SessionIndexGroupQuery): SessionGroupPage;
  listAll(query?: SessionIndexFilterQuery): readonly SessionSummaryRow[];
}

export const SessionIndexRef = createFacadeToken<SessionIndexFace>('sessionIndex');

interface CatalogFields {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly archived: number;
  readonly archivedAt: number | null;
}

export function createSessionIndex(props: CreateSessionIndexProps): FeatureSpec {
  return createFeature('sessionIndex', {
    app() {
      const app = useApp();
      const now = props.now ?? Date.now;
      if (props.dbPath !== ':memory:') {
        mkdirSync(dirname(props.dbPath), { recursive: true });
      }
      const db = new Database(props.dbPath);
      useCleanup(() => {
        db.close();
      });
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      migrateSessionIndex(db);

      const insertShell = db.prepare(
        'INSERT OR IGNORE INTO session_summary (id, created_at, updated_at) VALUES (?, ?, ?)',
      );
      const upsertCatalog = db.prepare(`
        INSERT INTO session_summary (id, workspace_id, cwd, title, archived, archived_at, created_at, updated_at)
        VALUES ($id, $workspaceId, $cwd, $title, $archived, $archivedAt, $now, $now)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = $workspaceId,
          cwd = $cwd,
          title = $title,
          archived = $archived,
          archived_at = $archivedAt,
          updated_at = $now
      `);
      const upsertCatalogFields = db.prepare(`
        INSERT INTO session_summary (id, workspace_id, cwd, title, archived, archived_at)
        VALUES ($id, $workspaceId, $cwd, $title, $archived, $archivedAt)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = $workspaceId,
          cwd = $cwd,
          title = $title,
          archived = $archived,
          archived_at = $archivedAt
      `);
      const applyLastTurn = db.prepare(
        'UPDATE session_summary SET last_turn_id = $turnId, last_turn_outcome = $outcome, updated_at = $now WHERE id = $id',
      );
      const applyPrompt = db.prepare(
        'UPDATE session_summary SET last_prompt = $prompt, updated_at = $now WHERE id = $id',
      );
      const touch = db.prepare('UPDATE session_summary SET updated_at = ? WHERE id = ?');
      const deleteById = db.prepare('DELETE FROM session_summary WHERE id = ?');
      const selectIds = db.prepare<unknown[], { id: string }>('SELECT id FROM session_summary');
      const selectBackfill = db.prepare<unknown[], { id: string }>(
        'SELECT id FROM session_summary WHERE created_at IS NULL OR updated_at IS NULL OR last_prompt IS NULL',
      );
      const backfill = db.prepare(`
        UPDATE session_summary SET
          created_at = COALESCE(created_at, $createdAt),
          updated_at = COALESCE(updated_at, $updatedAt),
          last_prompt = COALESCE(last_prompt, $lastPrompt),
          last_turn_id = COALESCE(last_turn_id, $lastTurnId),
          last_turn_outcome = COALESCE(last_turn_outcome, $lastTurnOutcome)
        WHERE id = $id
      `);
      const selectById = db.prepare<unknown[], RawSummaryRow>(
        'SELECT * FROM session_summary WHERE id = ?',
      );

      useOnApp('session.created', (event) => {
        const sessionId = event['sessionId'];
        if (typeof sessionId !== 'string') return;
        const at = now();
        insertShell.run(sessionId, at, at);
      });

      useOnApp('session.meta_updated', (event) => {
        const sessionId = event['sessionId'];
        if (typeof sessionId !== 'string') return;
        const meta = event['meta'];
        if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return;
        const patch = meta as Record<string, unknown>;
        const at = now();
        if (typeof patch['id'] === 'string' && patch['id'] === sessionId) {
          const record: SessionRecord = {
            id: patch['id'],
            ...(typeof patch['title'] === 'string' ? { title: patch['title'] } : {}),
            ...(isPlainObject(patch['metadata']) ? { metadata: patch['metadata'] } : {}),
          };
          upsertCatalog.run({ ...catalogFieldsOf(record), now: at });
        }
        if ('lastTurn' in patch) {
          const raw = patch['lastTurn'];
          const lastTurn = raw === null ? null : parseLastTurn(raw);
          if (raw === null || lastTurn !== undefined) {
            insertShell.run(sessionId, at, at);
            applyLastTurn.run({
              id: sessionId,
              turnId: lastTurn?.turnId ?? null,
              outcome: lastTurn?.outcome ?? null,
              now: at,
            });
          }
        }
      });

      useOnApp('message.appended', (event) => {
        if (event['agentId'] !== MAIN_AGENT_ID) return;
        const sessionId = event['sessionId'];
        if (typeof sessionId !== 'string') return;
        const at = now();
        insertShell.run(sessionId, at, at);
        const prompt = userPromptText(event['message']);
        if (prompt !== undefined) {
          applyPrompt.run({ id: sessionId, prompt, now: at });
        } else {
          touch.run(at, sessionId);
        }
      });

      useOnApp('session.deleted', (event) => {
        const sessionId = event['sessionId'];
        if (typeof sessionId !== 'string') return;
        deleteById.run(sessionId);
      });

      useReady(
        (async () => {
          const catalog = await app.space.list();
          const reconcileTx = db.transaction((records: readonly SessionRecord[]) => {
            const live = new Set(records.map((record) => record.id));
            for (const row of selectIds.all()) {
              if (!live.has(row.id)) deleteById.run(row.id);
            }
            for (const record of records) {
              upsertCatalogFields.run(catalogFieldsOf(record));
            }
          });
          reconcileTx(catalog);
          const sessionDir = props.sessionDir;
          if (sessionDir === undefined) return;
          for (const row of selectBackfill.all()) {
            let scan;
            try {
              scan = await scanSessionDir(sessionDir(row.id));
            } catch {
              continue;
            }
            backfill.run({
              id: row.id,
              createdAt: scan.firstActivityMs ?? null,
              updatedAt: scan.lastActivityMs ?? null,
              lastPrompt: scan.lastUserText ?? null,
              lastTurnId: scan.lastTurn?.turnId ?? null,
              lastTurnOutcome: scan.lastTurn?.outcome ?? null,
            });
          }
        })(),
      );

      const face: SessionIndexFace = {
        get: (id) => {
          const row = selectById.get(id);
          return row === undefined ? undefined : toSummaryRow(row);
        },
        list: (query) => listSummaries(db, query),
        listByWorkspace: (query) => listWorkspaceGroups(db, query),
        listAll: (query) => listAllSummaries(db, query),
      };
      useExpose(SessionIndexRef, face);
    },
  });
}

function catalogFieldsOf(record: SessionRecord): CatalogFields {
  return {
    id: record.id,
    workspaceId: sessionWorkspaceId(record) ?? null,
    cwd: sessionCwd(record) ?? null,
    title: record.title ?? null,
    archived: record.metadata?.['archived'] === true ? 1 : 0,
    archivedAt: archivedAtMs(record.metadata?.['archived_at']),
  };
}

function sessionCwd(record: SessionRecord): string | undefined {
  const value = record.metadata?.['cwd'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function archivedAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function parseLastTurn(raw: unknown): { turnId: number; outcome: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const turnId = (raw as { turnId?: unknown }).turnId;
  const outcome = (raw as { outcome?: unknown }).outcome;
  if (typeof turnId !== 'number' || !Number.isFinite(turnId)) return undefined;
  if (typeof outcome !== 'string') return undefined;
  return { turnId, outcome };
}

function userPromptText(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = (raw as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { role?: unknown }).role !== 'user') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
  }
  return text.trim().length > 0 ? text : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
