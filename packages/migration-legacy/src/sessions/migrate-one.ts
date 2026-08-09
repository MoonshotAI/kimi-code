import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { OldSessionStateSchema, type OldSessionState } from '../kimi-cli-schema.js';
import { targetSessionsDir } from '../paths.js';
import { computeWorkdirBucket } from './workdir-bucket.js';
import { closeDanglingToolCalls } from './close-tool-calls.js';
import {
  analyzeContextContent,
  translateContextLines,
  type NormalizedMessage,
} from './translator.js';
import { writeMainAgentWire } from './wire-writer.js';
import { writeSessionState } from './state-writer.js';
import { extractToolCallDisplays } from './tool-call-display.js';

export type MigrateOneResult =
  | { readonly outcome: 'migrated'; readonly targetDir: string }
  | { readonly outcome: 'already-migrated'; readonly targetDir: string }
  | { readonly outcome: 'conflict'; readonly targetDir: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'failed'; readonly reason: string };

export interface MigrateOneInput {
  readonly sourceSessionDir: string;
  readonly oldSessionUuid: string;
  readonly workdirPath: string;
  readonly targetHome: string;
}

export async function migrateOneSession(input: MigrateOneInput): Promise<MigrateOneResult> {
  const bucket = computeWorkdirBucket(input.workdirPath);
  const targetDir = join(targetSessionsDir(input.targetHome), bucket, `ses_${input.oldSessionUuid}`);

  if (existsSync(targetDir)) {
    const cls = await classifyExistingTarget(targetDir);
    // A dir we wrote ourselves on a previous run — idempotent re-run.
    if (cls === 'imported') {
      return { outcome: 'already-migrated', targetDir };
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

  let oldState: Partial<OldSessionState> = {};
  try {
    const stateText = await readFile(join(input.sourceSessionDir, 'state.json'), 'utf-8');
    oldState = OldSessionStateSchema.parse(JSON.parse(stateText));
  } catch {
    // missing or corrupt state — proceed with defaults
  }

  let messages: NormalizedMessage[] = [];
  let lastUserPrompt = '';
  let contextLines: readonly string[] = [];
  let oldWireText: string | undefined;
  try {
    const contextText = await readFile(join(input.sourceSessionDir, 'context.jsonl'), 'utf-8');
    contextLines = contextText.split(/\r?\n/);
    try {
      oldWireText = await readFile(join(input.sourceSessionDir, 'wire.jsonl'), 'utf-8');
    } catch {
      // A missing/corrupt wire must not prevent the model-facing context from
      // migrating; it only means UI display enrichment is unavailable.
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

  if (messages.length === 0) {
    // No `user`/`assistant`/`tool` rows survived translation. Re-analyze the
    // raw lines to tell a genuinely empty/cleared session apart from one
    // whose every line failed to parse — the latter is a real data problem
    // and must show up in `migration-errors.log`, not get silently lumped in
    // with skipped-empty. `classifySessionDir` normally catches both ahead
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
    // No recorded `wire_mtime`: fall back to the source `wire.jsonl` mtime —
    // the SAME signal `migrateSessionsStep`/detection rank recency by — so
    // post-migration `SessionStore.list()` ordering matches the detected
    // "most recent" order. `Date.now()` would stamp every such session with
    // the migration time and break resume ordering.
    try {
      createdAtMs = Math.floor(
        (await stat(join(input.sourceSessionDir, 'wire.jsonl'))).mtimeMs,
      );
    } catch {
      createdAtMs = Date.now();
    }
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
    await writeMainAgentWire(targetDir, { createdAtMs, messages });
    await writeSessionState(targetDir, {
      oldState,
      lastUserPrompt,
      sourcePath: input.sourceSessionDir,
      oldSessionUuid: input.oldSessionUuid,
      wireProtocolFromOld,
      createdAtMs,
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
