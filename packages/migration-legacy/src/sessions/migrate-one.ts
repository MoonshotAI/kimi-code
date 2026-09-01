import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import type { OldSessionState } from '../kimi-cli-schema.js';
import { readTodoItems } from '@moonshot-ai/agent-core-v2/features/todo/todoItem';
import { targetSessionsDir } from '../paths.js';
import { computeWorkdirBucket } from './workdir-bucket.js';
import { closeDanglingToolCalls } from './close-tool-calls.js';
import {
  analyzeContextContent,
  extractLastUsageTokenCount,
  translateContextLines,
  type NormalizedMessage,
} from './translator.js';
import { readMergedSessionState, type LegacySessionRef } from './source.js';
import { writeMainAgentWire } from './wire-writer.js';
import { writeSessionState } from './state-writer.js';
import { extractToolCallDisplays } from './tool-call-display.js';
import { repairImportedSessionWire } from './repair-imported.js';
import { buildSubagentTaskRecords, migrateLegacySubagents } from './subagents.js';
import { IMPORT_FORMAT_VERSION } from './turn-structure.js';

export type MigrateOneResult =
  | { readonly outcome: 'migrated'; readonly targetDir: string }
  | { readonly outcome: 'already-migrated'; readonly targetDir: string }
  | { readonly outcome: 'repaired'; readonly targetDir: string }
  | { readonly outcome: 'conflict'; readonly targetDir: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'failed'; readonly reason: string };

export interface MigrateOneInput {
  readonly source: LegacySessionRef;
  readonly workdirPath: string;
  readonly targetHome: string;
}

export async function migrateOneSession(input: MigrateOneInput): Promise<MigrateOneResult> {
  const bucket = computeWorkdirBucket(input.workdirPath);
  const targetDir = join(targetSessionsDir(input.targetHome), bucket, `ses_${input.source.uuid}`);

  if (existsSync(targetDir)) {
    const cls = await classifyExistingTarget(targetDir);
    // A dir we wrote ourselves on a previous run — idempotent re-run. Sessions
    // imported before the current import format existed get repaired in place;
    // a repair that cannot be applied is a real failure, not a silent skip:
    // reporting success would leave the session permanently needing repair
    // while every run misleadingly completes.
    if (cls === 'imported') {
      const formatVersion = await readImportFormatVersion(targetDir);
      if (formatVersion >= IMPORT_FORMAT_VERSION) {
        return { outcome: 'already-migrated', targetDir };
      }
      const repaired = await repairImportedSessionWire(targetDir).catch(() => false);
      if (repaired) return { outcome: 'repaired', targetDir };
      return {
        outcome: 'failed',
        reason:
          'imported session needs repair but its wire could not be repaired (missing, corrupt, or unwritable)',
      };
    }
    // A real, unrelated kimi-code session occupies the path — a true conflict.
    if (cls === 'foreign') {
      return { outcome: 'conflict', targetDir };
    }
    // 'debris': `state.json` is absent or corrupt — a prior migration was
    // killed mid-write. Treat it as stale and re-migrate, rather than
    // stranding this session under a permanent conflict on every future run.
    await rm(targetDir, { recursive: true, force: true });
  }

  const oldState: Partial<OldSessionState> = await readMergedSessionState(input.source.sessionDir);

  let messages: NormalizedMessage[] = [];
  let lastUserPrompt = '';
  let contextLines: readonly string[] = [];
  let oldWireText: string | undefined;
  try {
    if (input.source.contextPath === undefined) {
      return { outcome: 'failed', reason: 'cannot read context.jsonl' };
    }
    const contextText = await readFile(input.source.contextPath, 'utf-8');
    contextLines = contextText.split(/\r?\n/);
    if (input.source.sessionDir !== undefined) {
      try {
        oldWireText = await readFile(join(input.source.sessionDir, 'wire.jsonl'), 'utf-8');
      } catch {
        // A missing/corrupt wire must not prevent the model-facing context from
        // migrating; it only means UI display enrichment is unavailable.
      }
    }
    const toolCallDisplays =
      oldWireText === undefined ? undefined : extractToolCallDisplays(oldWireText);
    messages = closeDanglingToolCalls(
      translateContextLines(contextLines, toolCallDisplays),
    );
    lastUserPrompt = extractLastUserText(messages);
  } catch {
    return { outcome: 'failed', reason: 'cannot read context.jsonl' };
  }

  const customTitle = oldState.custom_title;
  const hasCustomTitle = typeof customTitle === 'string' && customTitle.length > 0;

  if (messages.length === 0 && !hasCustomTitle) {
    // No `user`/`assistant`/`tool` rows survived translation. Re-analyze the
    // raw lines to tell a genuinely empty/cleared session apart from one
    // whose every line failed to parse — the latter is a real data problem
    // and must show up in `migration-errors.log`, not get silently lumped in
    // with skipped-empty. `classifyLegacySession` normally catches both ahead
    // of time; this stays as a defense-in-depth safety net.
    if (analyzeContextContent(contextLines) === 'corrupt') {
      return {
        outcome: 'failed',
        reason: 'context.jsonl is corrupt: no parseable JSON lines',
      };
    }
    return { outcome: 'empty' };
  }

  const wireMtimeS = oldState.wire_mtime ?? null;
  let createdAtMs: number;
  if (wireMtimeS !== null && wireMtimeS !== undefined) {
    createdAtMs = Math.floor(wireMtimeS * 1000);
  } else {
    // No recorded `wire_mtime`: fall back to the source files' mtime — the
    // SAME signal detection ranks recency by — so post-migration
    // `SessionStore.list()` ordering matches the detected "most recent" order.
    // `Date.now()` would stamp every such session with the migration time and
    // break resume ordering.
    createdAtMs = await readSourceMtime(input.source) ?? Date.now();
  }

  let wireProtocolFromOld: string | null = null;
  if (oldWireText !== undefined) {
    try {
      const firstLine = oldWireText.split(/\r?\n/)[0];
      if (firstLine !== undefined && firstLine.length > 0) {
        const parsed: unknown = JSON.parse(firstLine);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { protocol_version?: unknown }).protocol_version === 'string'
        ) {
          wireProtocolFromOld = (parsed as { protocol_version: string }).protocol_version;
        }
      }
    } catch {
      // ignore a corrupt metadata line; display extraction already skips
      // malformed records independently.
    }
  }

  try {
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const subagents =
      input.source.sessionDir === undefined
        ? []
        : await migrateLegacySubagents(input.source.sessionDir, targetDir);
    await writeMainAgentWire(targetDir, {
      createdAtMs,
      messages,
      lastUsageTokenCount: extractLastUsageTokenCount(contextLines),
      todoItems: readTodoItems(oldState.todos),
      subagentTasks: subagents.map(buildSubagentTaskRecords),
    });
    await writeSessionState(targetDir, {
      oldState,
      sessionId: `ses_${input.source.uuid}`,
      workdirPath: input.workdirPath,
      lastUserPrompt,
      lastTurnReason: messages.some((m) => m.role === 'assistant') ? 'completed' : undefined,
      sourcePath: input.source.sessionDir ?? input.source.contextPath ?? '',
      oldSessionUuid: input.source.uuid,
      wireProtocolFromOld,
      createdAtMs,
      subagentIds: subagents.map((s) => s.agentId),
    });
  } catch (error) {
    // A partially-written targetDir would trip the conflict guard on re-run
    // and strand this session forever. Clean it up and report a soft failure
    // so the migration loop continues.
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    return { outcome: 'failed', reason };
  }

  // kimi-core's `SessionStore.list()` ranks sessions by the *filesystem*
  // mtimes of `state.json` / `wire.jsonl` / the session dir — not by the
  // `updatedAt` field. Writing newest-first would otherwise make the newest
  // original session the oldest by mtime, inverting `--continue` ordering.
  // Stamp the artifacts with the session's original timestamp so `list()`
  // reflects true recency. A utimes failure must never abort the session;
  // it only leaves ordering slightly off.
  await applyOriginalMtime(targetDir, createdAtMs);

  return { outcome: 'migrated', targetDir };
}

async function readSourceMtime(source: LegacySessionRef): Promise<number | undefined> {
  if (source.sessionDir !== undefined) {
    try {
      return Math.floor((await stat(join(source.sessionDir, 'wire.jsonl'))).mtimeMs);
    } catch {
      // fall through to the context payload's mtime
    }
  }
  if (source.contextPath !== undefined) {
    try {
      return Math.floor((await stat(source.contextPath)).mtimeMs);
    } catch {
      // fall through
    }
  }
  return undefined;
}

/**
 * Set the filesystem mtime of the migrated session artifacts to the session's
 * original timestamp. The session directory is stamped LAST, since writing
 * files into it bumps the directory mtime.
 */
async function applyOriginalMtime(targetDir: string, createdAtMs: number): Promise<void> {
  const stamp = new Date(createdAtMs);
  try {
    await utimes(join(targetDir, 'agents', 'main', 'wire.jsonl'), stamp, stamp);
    await utimes(join(targetDir, 'state.json'), stamp, stamp);
    await utimes(targetDir, stamp, stamp);
  } catch {
    // Non-fatal: ordering may be slightly off, but the migration succeeded.
  }
}

async function readImportFormatVersion(targetDir: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return 0;
    const custom = (parsed as { custom?: unknown }).custom;
    if (typeof custom !== 'object' || custom === null) return 0;
    const version = (custom as Record<string, unknown>)['import_format_version'];
    return typeof version === 'number' ? version : 0;
  } catch {
    return 0;
  }
}

type ExistingTarget = 'imported' | 'foreign' | 'debris';

/**
 * Classify an existing `targetDir`:
 *  - `imported`: a complete dir written by a previous run of this migrator.
 *  - `foreign`:  a real, unrelated kimi-code session occupying the path.
 *  - `debris`:   no `state.json`, or a corrupt/unparseable one — a prior
 *                migration was killed mid-write; safe to delete and re-migrate.
 */
async function classifyExistingTarget(targetDir: string): Promise<ExistingTarget> {
  let text: string;
  try {
    text = await readFile(join(targetDir, 'state.json'), 'utf-8');
  } catch {
    return 'debris'; // no state.json at all
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'debris'; // corrupt / half-written state.json
  }
  if (typeof parsed !== 'object' || parsed === null) return 'debris';
  const custom = (parsed as { custom?: unknown }).custom;
  if (
    typeof custom === 'object' &&
    custom !== null &&
    (custom as { imported_from_kimi_cli?: unknown }).imported_from_kimi_cli === true
  ) {
    return 'imported';
  }
  return 'foreign';
}

function extractLastUserText(messages: readonly NormalizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role !== 'user') continue;
    const textPart = m.content.find((p) => p.type === 'text');
    if (textPart && textPart.type === 'text') return textPart.text;
  }
  return '';
}
