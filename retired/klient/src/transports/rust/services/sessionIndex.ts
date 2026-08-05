/**
 * `sessionIndex` — the persisted session read model. Engine-backed: rust-loop
 * `sessionList` / `sessionGetStatus` (the engine has no archived concept, so
 * `archived` is always false and `countActive` counts live sessions).
 */

import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

interface EngineSessionRecordLike {
  id: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
  work_dir?: string;
}

interface SessionSummary {
  id: string;
  workspaceId: string;
  cwd?: string;
  title?: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  custom?: Record<string, unknown>;
}

function parseTime(value: string | undefined): number {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function toSessionSummary(record: EngineSessionRecordLike): SessionSummary {
  return {
    id: record.id,
    workspaceId: record.work_dir ?? '',
    cwd: record.work_dir,
    title: record.title,
    createdAt: parseTime(record.created_at),
    updatedAt: parseTime(record.updated_at),
    archived: false,
  };
}

async function listSessions(ctx: RustCallContext): Promise<SessionSummary[]> {
  const limit = (ctx.args[0] as { limit?: number } | undefined)?.limit;
  const result = await ctx.rust.sessionList(limit ?? 50, 0);
  return (result?.sessions ?? []).map(toSessionSummary);
}

export const sessionIndexService: RustServiceRegistry = {
  async list(ctx) {
    const query = (ctx.args[0] ?? {}) as {
      workspaceIds?: string[];
      limit?: number;
      cursor?: string;
    };
    const all = await listSessions(ctx);
    const filtered = query.workspaceIds === undefined
      ? all
      : all.filter((s) => query.workspaceIds!.includes(s.workspaceId));
    const limit = query.limit ?? 50;
    const page = filtered.slice(0, limit);
    const nextCursor =
      filtered.length > limit ? (page[page.length - 1]?.id ?? undefined) : undefined;
    return { items: page, nextCursor };
  },

  async get(ctx) {
    const sessionId = ctx.args[0] as string;
    const sessions = await listSessions(ctx);
    return sessions.find((s) => s.id === sessionId);
  },

  async countActive(ctx) {
    const workspaceIds = ctx.args[0] as string[] | undefined;
    const sessions = await listSessions(ctx);
    if (workspaceIds === undefined || workspaceIds.length === 0) return sessions.length;
    return sessions.filter((s) => workspaceIds.includes(s.workspaceId)).length;
  },
};

registerService('sessionIndex', sessionIndexService);
