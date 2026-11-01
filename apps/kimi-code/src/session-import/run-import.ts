/**
 * Import recent Claude Code and Codex sessions into the kimi-code home.
 *
 * Discovery and conversion live in `@moonshot-ai/session-import`; the session
 * directory format is written by `@moonshot-ai/migration-legacy`. A session id
 * derived from the source id makes reruns skip sessions imported before.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { effectiveModelAlias, type KimiConfig } from '@moonshot-ai/kimi-code-sdk';
import { importedSessionDir, writeImportedSession } from '@moonshot-ai/migration-legacy';
import { convertSession, DEFAULT_IMPORT_RATIO, findSessions, type SessionCandidate } from '@moonshot-ai/session-import';

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_CONTEXT_WINDOW = 131_072;
const COMPACTION_TRIGGER_RATIO = 0.85;
const RESERVED_CONTEXT_SIZE = 50_000;
const CONTINUATION_MARGIN = 30_000;
const ESTIMATE_UNDERCOUNT = 1.25;
const MIN_IMPORT_BUDGET = 16_384;

export const IMPORT_WINDOW_DAYS = [15, 30] as const;
export const IMPORT_BATCH_LIMIT = 100;

export interface ImportCandidate extends SessionCandidate {
  readonly sessionId: string;
}

export interface ImportScan {
  readonly candidates: readonly ImportCandidate[];
  readonly alreadyImported: number;
  /** Sessions whose project folder no longer exists; they are not candidates. */
  readonly missingFolder: number;
}

export interface ImportBudget {
  readonly contextWindow: number;
  readonly tokenBudget: number;
}

export interface ImportProgress {
  readonly index: number;
  readonly total: number;
  readonly candidate: ImportCandidate;
}

export interface ImportFailure {
  readonly path: string;
  readonly message: string;
}

export interface ImportReport {
  /** Session ids written by this run. */
  readonly imported: string[];
  alreadyImported: number;
  missingFolder: number;
  inUse: number;
  empty: number;
  unsupported: number;
  readonly failed: ImportFailure[];
  stopped: boolean;
}

export interface ImportOptions extends ImportBudget {
  readonly kimiHome: string;
  readonly now: number;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly shouldStop?: () => boolean;
}

function envPath(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

export function sourceHomes(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { readonly claudeHome: string; readonly codexHome: string } {
  return {
    claudeHome: envPath(env, 'CLAUDE_CONFIG_DIR', join(home, '.claude')),
    codexHome: envPath(env, 'CODEX_HOME', join(home, '.codex')),
  };
}

export function importedSessionId(session: SessionCandidate): string {
  if (/^[\w-]{1,80}$/.test(session.sourceId)) return `ses_${session.sourceId}`;
  return `ses_${createHash('sha256').update(`${session.source}:${session.sourceId}`).digest('hex').slice(0, 32)}`;
}

/**
 * Size imports for the default model, with its `overrides` applied the way
 * the engine applies them. The window is its input limit. The
 * budget keeps the imported message below the engine's automatic compaction
 * threshold (trigger ratio or reserved context, whichever comes first), with
 * room for the system prompt, tools and the first exchange, so continuing an
 * imported session does not start by compacting it away. The import
 * estimator undercounts code and JSON by about a quarter, hence the divisor.
 */
export function importBudget(config: Pick<KimiConfig, 'defaultModel' | 'models' | 'loopControl'>): ImportBudget {
  const alias = config.defaultModel === undefined ? undefined : config.models?.[config.defaultModel];
  const model = alias === undefined ? undefined : effectiveModelAlias(alias);
  const limit = Math.min(model?.maxInputSize ?? Infinity, model?.maxContextSize ?? Infinity);
  const contextWindow = Number.isFinite(limit) ? limit : FALLBACK_CONTEXT_WINDOW;
  const reserved = config.loopControl?.reservedContextSize ?? RESERVED_CONTEXT_SIZE;
  const threshold = Math.min(
    contextWindow * (config.loopControl?.compactionTriggerRatio ?? COMPACTION_TRIGGER_RATIO),
    reserved > 0 && reserved < contextWindow ? contextWindow - reserved : contextWindow,
  );
  const allowance = Math.max(MIN_IMPORT_BUDGET, (threshold - CONTINUATION_MARGIN) / ESTIMATE_UNDERCOUNT);
  return { contextWindow, tokenBudget: Math.floor(Math.min(contextWindow * DEFAULT_IMPORT_RATIO, allowance)) };
}

function isImported(kimiHome: string, workDir: string, sessionId: string): boolean {
  return existsSync(join(importedSessionDir(kimiHome, workDir, sessionId), 'state.json'));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function scanImportableSessions(input: {
  readonly kimiHome: string;
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly now: number;
}): Promise<ImportScan> {
  const since = input.now - Math.max(...IMPORT_WINDOW_DAYS) * DAY_MS;
  const candidates: ImportCandidate[] = [];
  let alreadyImported = 0;
  let missingFolder = 0;
  for (const session of await findSessions({ claudeHome: input.claudeHome, codexHome: input.codexHome, since })) {
    const sessionId = importedSessionId(session);
    if (isImported(input.kimiHome, session.cwd, sessionId)) alreadyImported++;
    else if (!isDirectory(session.cwd)) missingFolder++;
    else candidates.push({ ...session, sessionId });
  }
  return { candidates, alreadyImported, missingFolder };
}

export function candidatesWithin(scan: ImportScan, days: number, now: number): ImportCandidate[] {
  return scan.candidates.filter((candidate) => candidate.modifiedAt >= now - days * DAY_MS);
}

async function discard(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true });
  await rmdir(dirname(sessionDir)).catch(() => undefined);
}

type Outcome = 'imported' | 'alreadyImported' | 'missingFolder' | 'inUse' | 'empty' | 'unsupported' | ImportFailure;

async function importOne(candidate: ImportCandidate, options: ImportOptions): Promise<Outcome> {
  if (!isDirectory(candidate.cwd)) return 'missingFolder';
  if (isImported(options.kimiHome, candidate.cwd, candidate.sessionId)) return 'alreadyImported';
  const sessionDir = importedSessionDir(options.kimiHome, candidate.cwd, candidate.sessionId);
  await rm(sessionDir, { recursive: true, force: true });
  try {
    const attachmentDirectory = join(sessionDir, 'attachments');
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
    const result = await convertSession({
      source: candidate.source,
      sourcePath: candidate.path,
      attachmentDirectory,
      contextWindow: options.contextWindow,
      tokenBudget: options.tokenBudget,
      subagentPaths: candidate.subagentPaths,
      stateDatabasePath: candidate.stateDatabasePath,
    });
    if (result.status === 'unreliable') {
      await discard(sessionDir);
      if (result.error.code === 'SOURCE_CHANGED') return 'inUse';
      if (result.error.code === 'EMPTY_SOURCE_HISTORY') return 'empty';
      if (result.error.code === 'UNSUPPORTED_HISTORY_BASE') return 'unsupported';
      return { path: candidate.path, message: result.error.message };
    }
    await writeImportedSession({
      targetHome: options.kimiHome,
      sessionId: candidate.sessionId,
      workDir: candidate.cwd,
      title: result.title ?? 'Imported session',
      lastPrompt: result.lastPrompt ?? '',
      updatedAtMs: Math.round(candidate.modifiedAt),
      messages: result.messages,
      custom: {
        imported_from: candidate.source,
        imported_source_id: candidate.sourceId,
        imported_source_path: candidate.path,
        imported_at: new Date(options.now).toISOString(),
      },
    });
    return 'imported';
  } catch (error) {
    await discard(sessionDir);
    return { path: candidate.path, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Import the newest `IMPORT_BATCH_LIMIT` candidates one at a time; `shouldStop` is checked between sessions. */
export async function importSessions(
  candidates: readonly ImportCandidate[],
  options: ImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = { imported: [], alreadyImported: 0, missingFolder: 0, inUse: 0, empty: 0, unsupported: 0, failed: [], stopped: false };
  const batch = candidates.slice(0, IMPORT_BATCH_LIMIT);
  for (const [index, candidate] of batch.entries()) {
    if (options.shouldStop?.() === true) {
      report.stopped = true;
      break;
    }
    options.onProgress?.({ index, total: batch.length, candidate });
    const outcome = await importOne(candidate, options);
    if (outcome === 'imported') report.imported.push(candidate.sessionId);
    else if (typeof outcome === 'string') report[outcome]++;
    else report.failed.push(outcome);
  }
  return report;
}
