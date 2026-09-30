import type Database from 'better-sqlite3';

export interface SessionSummaryRow {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastPrompt: string | null;
  readonly lastTurnId: number | null;
  readonly lastTurnOutcome: string | null;
  readonly archived: boolean;
  readonly archivedAt: number | null;
}

export interface RawSummaryRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly title: string | null;
  readonly created_at: number | null;
  readonly updated_at: number | null;
  readonly last_prompt: string | null;
  readonly last_turn_id: number | null;
  readonly last_turn_outcome: string | null;
  readonly archived: number;
  readonly archived_at: number | null;
}

export function migrateSessionIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summary (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_prompt TEXT,
      last_turn_id INTEGER,
      last_turn_outcome TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_summary_updated_at ON session_summary (updated_at);
    CREATE INDEX IF NOT EXISTS session_summary_workspace_id ON session_summary (workspace_id);
  `);
}

export function toSummaryRow(row: RawSummaryRow): SessionSummaryRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
    lastPrompt: row.last_prompt,
    lastTurnId: row.last_turn_id,
    lastTurnOutcome: row.last_turn_outcome,
    archived: row.archived !== 0,
    archivedAt: row.archived_at,
  };
}
