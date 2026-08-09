import type { Dirent } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { dirname, isAbsolute, join, relative, resolve } from 'pathe';

import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';
import type { SessionIndexEntry } from '#/session/store/session-index';
import {
  appendSessionIndexDeletion,
  appendSessionIndexEntry,
  readSessionIndex,
} from '#/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir } from '#/session/store/workdir-key';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
} from '#/session/prompt-metadata';
import type { JsonObject, ListSessionsPayload, SessionSummary } from '#/rpc/core-api';
import {
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordOf,
} from '../../agent/records';

const SessionSummaryStateSchema = z.object({
  archived: z.boolean().optional(),
  customTitle: z.string().optional(),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  title: z.string().optional(),
  workDir: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const FORKED_SESSION_DROPPED_FILES = ['upcoming-goals.json'] as const;

type SessionSummaryState = z.infer<typeof SessionSummaryStateSchema>;

export interface CreateSessionRecordInput {
  readonly id: string;
  readonly workDir: string;
}

export interface ForkSessionRecordInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  readonly turnIndex?: number;
}

export type SessionStoreOptions = {
  /**
   * Optional identity hook (wired by the services layer from the workspace
   * registry): the already-registered workspace id for the same physical root
   * as `workDir`, or undefined when no entry matches. Bucket derivation
   * prefers it over minting a fresh `encodeWorkDirKey` hash, so a session
   * created from a case/slash variant of a registered Windows root lands in
   * the registered bucket instead of splitting into a second one.
   */
  readonly resolveWorkspaceId?: (workDir: string) => Promise<string | undefined>;
};

export class SessionStore {
  readonly sessionsDir: string;
  private readonly resolveWorkspaceId: SessionStoreOptions['resolveWorkspaceId'];

  constructor(
    readonly homeDir: string,
    options: SessionStoreOptions = {},
  ) {
    this.sessionsDir = join(homeDir, 'sessions');
    this.resolveWorkspaceId = options.resolveWorkspaceId;
  }

  sessionDirFor(input: { readonly id: string; readonly workDir: string }): string {
    assertSafeSessionId(input.id);
    return join(this.sessionsDir, encodeWorkDirKey(normalizeWorkDir(input.workDir)), input.id);
  }

  /**
   * Bucket key for a workDir: asks the workspace registry (when wired) for the
   * registered id of the same physical root — see SessionStoreOptions — and
   * prefers it over the freshly minted `encodeWorkDirKey` hash. Falls back to
   * minting when the resolver is absent, errors, or returns an id that is not
   * a safe bucket name (registry contents are user-editable state; minted ids
   * always pass `isSafeSessionId`).
   */
  private async bucketKeyFor(workDir: string): Promise<string> {
    let resolved: string | undefined;
    try {
      resolved = await this.resolveWorkspaceId?.(workDir);
    } catch {
      resolved = undefined;
    }
    return resolved !== undefined && isSafeSessionId(resolved)
      ? resolved
      : encodeWorkDirKey(normalizeWorkDir(workDir));
  }

  /** Like `sessionDirFor`, but under the registry-resolved bucket. */
  private async resolvedSessionDirFor(input: {
    readonly id: string;
    readonly workDir: string;
  }): Promise<string> {
    assertSafeSessionId(input.id);
    return join(this.sessionsDir, await this.bucketKeyFor(input.workDir), input.id);
  }

  /** Bucket directory for a workDir, registry-resolved when possible. */
  private async bucketDirFor(workDir: string): Promise<string> {
    return join(this.sessionsDir, await this.bucketKeyFor(workDir));
  }

  async create(input: CreateSessionRecordInput): Promise<SessionSummary> {
    assertSafeSessionId(input.id);
    const workDir = normalizeWorkDir(input.workDir);
    const indexed = await this.findSessionEntry(input.id);
    if (indexed !== undefined && (await isDirectory(indexed.sessionDir))) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.id}" already exists`);
    }

    const dir = await this.resolvedSessionDirFor({ id: input.id, workDir });
    if (await isDirectory(dir)) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.id}" already exists`);
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendSessionIndexEntry(this.homeDir, {
      sessionId: input.id,
      sessionDir: dir,
      workDir,
    });
    return this.summaryFromDir(input.id, dir, workDir);
  }

  async fork(input: ForkSessionRecordInput): Promise<SessionSummary> {
    assertForkTurnIndex(input.turnIndex);
    const source = await this.findExistingSessionEntry(input.sourceId);
    assertSafeSessionId(input.targetId);
    const indexed = await this.findSessionEntry(input.targetId);
    if (indexed !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    const targetDir = await this.resolvedSessionDirFor({ id: input.targetId, workDir: source.workDir });
    if (await isDirectory(targetDir)) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    await mkdir(dirname(targetDir), { recursive: true, mode: 0o700 });
    try {
      await cp(source.sessionDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await dropForkedSessionFiles(targetDir);
      const fullForkedState = await this.writeForkedState(
        input,
        source.sessionDir,
        source.workDir,
        targetDir,
      );
      const forkedState = input.turnIndex === undefined
        ? fullForkedState
        : await truncateForkedSessionAtTurn(
            targetDir,
            input.sourceId,
            input.turnIndex,
            fullForkedState,
          );
      await appendForkedMarkers(forkedState);
      const summary = await this.summaryFromDir(input.targetId, targetDir, source.workDir);
      await appendSessionIndexEntry(this.homeDir, {
        sessionId: input.targetId,
        sessionDir: targetDir,
        workDir: source.workDir,
      });
      return summary;
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<SessionSummary> {
    const entry = await this.findExistingSessionEntry(id);
    return this.summaryFromDir(id, entry.sessionDir, entry.workDir);
  }

  async rename(id: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    const entry = await this.findExistingSessionEntry(id);
    const statePath = join(entry.sessionDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(ErrorCodes.SESSION_STATE_NOT_FOUND, `Session "${id}" state.json was not found`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session "${id}" state.json is invalid`);
    }
    const next: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      title: normalized,
      isCustomTitle: true,
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }

  async archive(id: string): Promise<SessionSummary> {
    const entry = await this.findExistingSessionEntry(id);
    const statePath = join(entry.sessionDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(ErrorCodes.SESSION_STATE_NOT_FOUND, `Session "${id}" state.json was not found`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session "${id}" state.json is invalid`);
    }
    const now = new Date().toISOString();
    const next: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      archived: true,
      updatedAt: now,
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return this.summaryFromDir(id, entry.sessionDir, entry.workDir);
  }

  async delete(id: string): Promise<void> {
    const entry = await this.findExistingSessionEntry(id);
    await rm(entry.sessionDir, { recursive: true, force: true });
    await appendSessionIndexDeletion(this.homeDir, id);
  }

  async list(options: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    const workDir =
      options.workDir === undefined ? undefined : normalizeRequiredWorkDir(options.workDir);
    const sessionId = normalizeOptionalSessionId(options.sessionId);
    const includeArchive = options.includeArchive === true;

    if (workDir !== undefined) {
      if (sessionId !== undefined) {
        const local = await this.summaryFromWorkDirSession(sessionId, workDir, includeArchive);
        if (local !== undefined) return [local];
        return this.listSessionId(sessionId, includeArchive);
      }
      return this.listWorkDir(workDir, includeArchive);
    }

    if (sessionId !== undefined) {
      return this.listSessionId(sessionId, includeArchive);
    }
    return this.listAll(includeArchive);
  }

  /**
   * Rebuild the global session index from the session directories on disk.
   *
   * The bucket directory name is a one-way hash of the workDir, so the workDir
   * can only be recovered from each session's self-describing `state.json`
   * (`workDir`, falling back to `custom.cwd` for older sessions). Sessions that
   * record no workDir, or whose recorded workDir does not match the bucket they
   * live in, are left untouched rather than writing a misleading entry.
   *
   * The index is append-only and `readSessionIndex` lets later lines override
   * earlier ones for the same id, so appending a corrected line both adds
   * missing entries and repairs stale ones. Best-effort: never throws.
   */
  async reindex(): Promise<{ scanned: number; added: number; repaired: number }> {
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    let bucketEntries;
    try {
      bucketEntries = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, added: 0, repaired: 0 };
    }

    let scanned = 0;
    let added = 0;
    let repaired = 0;

    for (const bucket of bucketEntries) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = join(this.sessionsDir, bucket.name);
      let sessionEntries;
      try {
        sessionEntries = await readdir(bucketDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of sessionEntries) {
        if (!entry.isDirectory()) continue;
        const id = entry.name;
        if (!isSafeSessionId(id)) continue;
        const sessionDir = join(bucketDir, id);
        const workDir = await this.recoverWorkDir(sessionDir);
        if (workDir === undefined) continue;
        scanned++;

        let expectedDir: string;
        try {
          expectedDir = this.sessionDirFor({ id, workDir });
        } catch {
          continue;
        }
        // Refuse to index a session whose recorded workDir does not match the
        // bucket it lives in (corrupt or foreign state). The registry-resolved
        // bucket is accepted too: sessions created with a wired resolver live
        // in the registered bucket even though their workDir mints elsewhere.
        if (
          !areSameFsPath(sessionDir, expectedDir) &&
          !areSameFsPath(sessionDir, await this.resolvedSessionDirFor({ id, workDir }))
        ) {
          continue;
        }

        const existing = index.get(id);
        if (
          existing !== undefined &&
          areSameFsPath(existing.sessionDir, sessionDir) &&
          existing.workDir === workDir
        ) {
          continue;
        }

        await appendSessionIndexEntry(this.homeDir, { sessionId: id, sessionDir, workDir });
        index.set(id, { sessionId: id, sessionDir, workDir });
        if (existing === undefined) added++;
        else repaired++;
      }
    }
    return { scanned, added, repaired };
  }

  private async recoverWorkDir(sessionDir: string): Promise<string | undefined> {
    const state = await readOptionalState(sessionDir);
    if (state?.workDir !== undefined) {
      try {
        return normalizeWorkDir(state.workDir);
      } catch {
        return undefined;
      }
    }
    const legacyCwd = state?.custom?.['cwd'];
    if (typeof legacyCwd === 'string' && legacyCwd.length > 0) {
      try {
        return normalizeWorkDir(legacyCwd);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async listWorkDir(
    workDir: string,
    includeArchive: boolean,
  ): Promise<readonly SessionSummary[]> {
    const bucketDir = await this.bucketDirFor(workDir);
    let entries: Dirent[] = [];
    try {
      entries = await readdir(bucketDir, { withFileTypes: true });
    } catch {
      // The same Windows directory may have an older bucket whose drive/share
      // casing differs. The index fallback below can still recover it.
    }

    const sessions: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!isSafeSessionId(id)) continue;
      const dir = join(bucketDir, id);
      const summary = await this.summaryFromDir(id, dir, workDir);
      if (!includeArchive && summary.archived === true) continue;
      sessions.push(summary);
      seen.add(id);
    }

    // Do not change the established bucket hash: that would hide every
    // existing Windows session after an upgrade. Instead merge indexed
    // sessions whose persisted workDir names the same case-insensitive drive
    // or UNC location (for example TUI `C:/Work` vs VS Code `c:\\Work`).
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    for (const entry of index.values()) {
      if (seen.has(entry.sessionId) || !(await isDirectory(entry.sessionDir))) continue;
      const summary = await this.summaryFromDir(entry.sessionId, entry.sessionDir, entry.workDir);
      if (!areSameFsPath(summary.workDir, workDir)) continue;
      if (!includeArchive && summary.archived === true) continue;
      sessions.push(summary);
      seen.add(entry.sessionId);
    }
    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async listSessionId(
    sessionId: string,
    includeArchive: boolean,
  ): Promise<readonly SessionSummary[]> {
    try {
      const summary = await this.get(sessionId);
      if (!includeArchive && summary.archived === true) return [];
      return [summary];
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND) {
        return [];
      }
      throw error;
    }
  }

  private async listAll(includeArchive: boolean): Promise<readonly SessionSummary[]> {
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    const sessions: SessionSummary[] = [];
    for (const entry of index.values()) {
      if (!(await isDirectory(entry.sessionDir))) continue;
      const summary = await this.summaryFromDir(entry.sessionId, entry.sessionDir, entry.workDir);
      if (!includeArchive && summary.archived === true) continue;
      sessions.push(summary);
    }
    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async summaryFromWorkDirSession(
    sessionId: string,
    workDir: string,
    includeArchive: boolean,
  ): Promise<SessionSummary | undefined> {
    if (!isSafeSessionId(sessionId)) return undefined;
    const sessionDir = await this.resolvedSessionDirFor({ id: sessionId, workDir });
    if (!(await isDirectory(sessionDir))) return undefined;
    const summary = await this.summaryFromDir(sessionId, sessionDir, workDir);
    if (!includeArchive && summary.archived === true) return undefined;
    return summary;
  }

  async assertDirectory(id: string): Promise<string> {
    return (await this.findExistingSessionEntry(id)).sessionDir;
  }

  private async findSessionEntry(id: string): Promise<SessionIndexEntry | undefined> {
    if (!isSafeSessionId(id)) return undefined;
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    return index.get(id);
  }

  private async findExistingSessionEntry(id: string): Promise<SessionIndexEntry> {
    const entry = await this.findSessionEntry(id);
    if (entry !== undefined && (await isDirectory(entry.sessionDir))) return entry;
    throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found`, {
      details: { sessionId: id },
    });
  }

  private async writeForkedState(
    input: ForkSessionRecordInput,
    sourceDir: string,
    sourceWorkDir: string,
    targetDir: string,
  ): Promise<Record<string, unknown>> {
    const statePath = join(targetDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_NOT_FOUND,
        `Session "${input.sourceId}" state.json was not found`,
        {
          cause: error,
        },
      );
    }
    if (!isRecord(parsed)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session "${input.sourceId}" state.json is invalid`,
      );
    }

    const title = normalizeForkTitle(input.title, parsed['title']);
    const now = new Date().toISOString();
    const next: Record<string, unknown> = {
      ...parsed,
      createdAt: now,
      updatedAt: now,
      workDir: sourceWorkDir,
      title,
      isCustomTitle: input.title === undefined ? parsed['isCustomTitle'] === true : true,
      forkedFrom: input.sourceId,
      agents: rewriteAgentHomedirs(parsed['agents'], sourceDir, targetDir),
      custom: forkCustomMetadata(parsed['custom'], input.metadata),
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return next;
  }

  private async summaryFromDir(
    id: string,
    sessionDir: string,
    workDir: string,
  ): Promise<SessionSummary> {
    const dirStat = await stat(sessionDir);
    const state = await readOptionalState(sessionDir);
    const [stateInfo, wireInfo, agentsWireMtime] = await Promise.all([
      statIfExists(join(sessionDir, 'state.json')),
      statIfExists(join(sessionDir, 'wire.jsonl')),
      latestAgentWireMtime(sessionDir),
    ]);
    return {
      id,
      workDir: state?.workDir ?? workDir,
      sessionDir,
      createdAt: timestampOrFallback(dirStat.birthtimeMs, dirStat.ctimeMs),
      updatedAt: Math.max(
        dirStat.mtimeMs,
        stateInfo?.mtimeMs ?? 0,
        wireInfo?.mtimeMs ?? 0,
        agentsWireMtime ?? 0,
      ),
      archived: state?.archived === true,
      title: titleFromState(state),
      lastPrompt: state?.lastPrompt,
      metadata: metadataFromState(state),
    };
  }
}

function metadataFromState(state: SessionSummaryState | undefined): JsonObject | undefined {
  if (state === undefined || state.custom === undefined) return undefined;
  return state.custom as JsonObject;
}

function forkCustomMetadata(source: unknown, metadata: JsonObject | undefined): Record<string, unknown> {
  return {
    ...customMetadataWithoutGoal(source),
    ...customMetadataWithoutGoal(metadata),
  };
}

async function dropForkedSessionFiles(sessionDir: string): Promise<void> {
  await Promise.all(
    FORKED_SESSION_DROPPED_FILES.map((fileName) => rm(join(sessionDir, fileName), { force: true })),
  );
}

interface MainTurnSlice {
  readonly records: readonly AgentRecord[];
  readonly cutoffTime?: number;
  readonly lastPrompt?: string;
}

async function truncateForkedSessionAtTurn(
  sessionDir: string,
  sourceSessionId: string,
  turnIndex: number,
  state: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agents = state['agents'];
  if (!isRecord(agents) || !isRecord(agents['main'])) {
    throw new KimiError(
      ErrorCodes.SESSION_STATE_INVALID,
      `Session "${sourceSessionId}" has no main agent metadata`,
    );
  }

  const mainAgentDir = join(sessionDir, 'agents', 'main');
  const mainPersistence = new FileSystemAgentRecordPersistence(
    join(mainAgentDir, 'wire.jsonl'),
  );
  const mainRecords = await readAgentRecords(mainPersistence);
  const mainSlice = sliceMainRecordsAtTurn(mainRecords, sourceSessionId, turnIndex);
  mainPersistence.rewrite(mainSlice.records);
  await mainPersistence.flush();

  const retainedAgents: Record<string, unknown> = {
    main: withAgentHomedir(agents['main'], mainAgentDir),
  };
  for (const [agentId, agentMeta] of Object.entries(agents)) {
    if (agentId === 'main') continue;
    const agentDir = join(sessionDir, 'agents', agentId);
    const retained = await truncateSubagentAtTime(agentDir, mainSlice.cutoffTime);
    if (retained) {
      retainedAgents[agentId] = withAgentHomedir(agentMeta, agentDir);
      continue;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
  dropAgentsWithMissingParents(retainedAgents);

  for (const agentId of Object.keys(agents)) {
    if (retainedAgents[agentId] !== undefined) continue;
    await rm(join(sessionDir, 'agents', agentId), { recursive: true, force: true });
  }

  for (const agentId of Object.keys(retainedAgents)) {
    const agentDir = join(sessionDir, 'agents', agentId);
    await Promise.all([
      rm(join(agentDir, 'tasks'), { recursive: true, force: true }),
      rm(join(agentDir, 'cron'), { recursive: true, force: true }),
    ]);
  }

  const next = {
    ...state,
    lastPrompt: mainSlice.lastPrompt,
    agents: retainedAgents,
  };
  await writeFile(join(sessionDir, 'state.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

function withAgentHomedir(agentMeta: unknown, homedir: string): unknown {
  return isRecord(agentMeta) ? { ...agentMeta, homedir } : agentMeta;
}

async function readAgentRecords(
  persistence: FileSystemAgentRecordPersistence,
): Promise<readonly AgentRecord[]> {
  const records: AgentRecord[] = [];
  for await (const record of persistence.read()) {
    records.push(record);
  }
  return records;
}

function sliceMainRecordsAtTurn(
  records: readonly AgentRecord[],
  sourceSessionId: string,
  turnIndex: number,
): MainTurnSlice {
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
  const start = turnStarts[turnIndex];
  if (start === undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const end = turnStarts[turnIndex + 1] ?? records.length;
  const retainedTurnInputs = turnInputIndicesThrough(records, turnIndex);
  const retained = records
    .slice(0, end)
    .filter(
      (record, index) =>
        !isUserVisibleTurnInputRecord(record) || retainedTurnInputs.has(index),
    );
  const cutoffTimes = retained
    .map(recordTime)
    .filter((time): time is number => time !== undefined);
  const lastPrompt = promptMetadataFromTurnRecord(records[start]!);
  return {
    records: retained,
    cutoffTime: cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes),
    lastPrompt,
  };
}

async function truncateSubagentAtTime(
  agentDir: string,
  cutoffTime: number | undefined,
): Promise<boolean> {
  if (cutoffTime === undefined) return false;
  const persistence = new FileSystemAgentRecordPersistence(join(agentDir, 'wire.jsonl'));
  const records = await readAgentRecords(persistence);
  let end = records.length;
  for (let index = 0; index < records.length; index += 1) {
    const time = recordTime(records[index]!);
    if (time !== undefined && time > cutoffTime) {
      end = index;
      break;
    }
  }
  const retained = records.slice(0, end);
  if (retained.length === 0) return false;
  persistence.rewrite(retained);
  await persistence.flush();
  return true;
}

function dropAgentsWithMissingParents(agents: Record<string, unknown>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [agentId, agentMeta] of Object.entries(agents)) {
      if (agentId === 'main' || !isRecord(agentMeta)) continue;
      const parentAgentId = agentMeta['parentAgentId'];
      if (
        typeof parentAgentId === 'string' &&
        parentAgentId !== 'main' &&
        agents[parentAgentId] === undefined
      ) {
        delete agents[agentId];
        changed = true;
      }
    }
  }
}

function recordTime(record: AgentRecord): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  if (
    record.type === 'metadata' &&
    typeof record.created_at === 'number' &&
    Number.isFinite(record.created_at)
  ) {
    return record.created_at;
  }
  return undefined;
}

function isUserVisibleTurnRecord(record: AgentRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const { message } = record;
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      return message.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
    case 'system_trigger':
      return false;
  }
}

function isUserVisibleTurnInputRecord(record: AgentRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  switch (record.origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return record.origin.trigger === 'user-slash';
    case 'shell_command':
      return record.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
    case 'system_trigger':
      return false;
  }
}

function turnInputIndicesThrough(
  records: readonly AgentRecord[],
  turnIndex: number,
): ReadonlySet<number> {
  const pending: number[] = [];
  const retained = new Set<number>();
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (isUserVisibleTurnInputRecord(record)) {
      pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;

    const matchAt = findMatchingTurnInput(records, pending, record);
    if (matchAt !== -1) {
      const [inputIndex] = pending.splice(matchAt, 1);
      if (visibleTurnIndex <= turnIndex && inputIndex !== undefined) {
        retained.add(inputIndex);
      }
    }
    visibleTurnIndex += 1;
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly AgentRecord[],
  pending: readonly number[],
  turnRecord: AgentRecord,
): number {
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, true),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, false),
  );
}

function turnInputMatchesRecord(
  inputRecord: AgentRecord,
  turnRecord: AgentRecord,
  compareContent: boolean,
): boolean {
  if (
    (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') ||
    turnRecord.type !== 'context.append_message' ||
    turnRecord.message.role !== 'user'
  ) {
    return false;
  }
  if (!sameTurnOrigin(inputRecord.origin.kind, turnRecord.message.origin?.kind)) return false;
  return !compareContent || JSON.stringify(inputRecord.input) === JSON.stringify(turnRecord.message.content);
}

function sameTurnOrigin(inputKind: string, messageKind: string | undefined): boolean {
  if (inputKind === 'user') return messageKind === undefined || messageKind === 'user';
  return inputKind === messageKind;
}

function promptMetadataFromTurnRecord(record: AgentRecord): string | undefined {
  if (record.type !== 'context.append_message' || record.message.role !== 'user') {
    return undefined;
  }
  const { message } = record;
  if (message.origin?.kind === 'skill_activation') {
    return promptMetadataTextFromSkill({
      name: message.origin.skillName,
      args: message.origin.skillArgs,
    });
  }
  if (message.origin?.kind === 'plugin_command') {
    return promptMetadataTextFromPluginCommand({
      pluginId: message.origin.pluginId,
      commandName: message.origin.commandName,
      args: message.origin.commandArgs,
    });
  }
  return promptMetadataTextFromPayload({ input: message.content });
}

function assertForkTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    'forkSession turnIndex must be a non-negative safe integer',
    { details: { turnIndex } },
  );
}

async function appendForkedMarkers(state: Record<string, unknown>): Promise<void> {
  const record: AgentRecordOf<'forked'> = { type: 'forked', time: Date.now() };

  const agents = state['agents'];
  if (!isRecord(agents)) return;

  const paths = new Set<string>();
  for (const agentMeta of Object.values(agents)) {
    if (!isRecord(agentMeta)) continue;
    const homedir = agentMeta['homedir'];
    if (typeof homedir !== 'string') continue;
    paths.add(join(homedir, 'wire.jsonl'));
  }

  await Promise.all([...paths].map(async (path) => {
    const persistence = new FileSystemAgentRecordPersistence(path);
    persistence.append(record);
    await persistence.flush();
  }));
}

function customMetadataWithoutGoal(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const custom: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'goal') continue;
    custom[key] = entry;
  }
  return custom;
}

async function latestAgentWireMtime(sessionDir: string): Promise<number | undefined> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latest = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wireInfo = await statIfExists(join(agentsDir, entry.name, 'wire.jsonl'));
    latest = Math.max(latest, wireInfo?.mtimeMs ?? 0);
  }
  return latest > 0 ? latest : undefined;
}

function titleFromState(state: SessionSummaryState | undefined): string | undefined {
  if (state === undefined) return undefined;
  if (typeof state.isCustomTitle === 'boolean' && typeof state.title === 'string') {
    return state.title;
  }
  if (typeof state.customTitle === 'string') return state.customTitle;
  return typeof state.title === 'string' ? state.title : undefined;
}

async function readOptionalState(sessionDir: string): Promise<SessionSummaryState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as unknown;
    const result = SessionSummaryStateSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRequiredWorkDir(workDir: string): string {
  if (workDir.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, 'listSessions requires workDir');
  }
  return normalizeWorkDir(workDir);
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : sessionId.trim();
}

function normalizeForkTitle(title: string | undefined, fallback: unknown): string {
  if (title !== undefined) {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    return normalized;
  }
  return typeof fallback === 'string' && fallback.trim().length > 0 ? fallback : 'New Session';
}

function rewriteAgentHomedirs(value: unknown, sourceDir: string, targetDir: string): unknown {
  if (!isRecord(value)) return {};

  const agents: Record<string, unknown> = {};
  for (const [agentId, agentMeta] of Object.entries(value)) {
    if (!isRecord(agentMeta)) {
      agents[agentId] = agentMeta;
      continue;
    }
    const homedir = agentMeta['homedir'];
    agents[agentId] = {
      ...agentMeta,
      homedir:
        typeof homedir === 'string' ? remapSessionPath(homedir, sourceDir, targetDir) : homedir,
    };
  }
  return agents;
}

function remapSessionPath(value: string, sourceDir: string, targetDir: string): string {
  const rel = relative(sourceDir, value);
  if (rel === '') return targetDir;
  if (rel.startsWith('..') || isAbsolute(rel)) return value;
  return join(targetDir, rel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function areSameFsPath(left: string, right: string): boolean {
  if (isWindowsAbsolutePath(left) || isWindowsAbsolutePath(right)) {
    return nodePath.win32.resolve(left).toLowerCase() === nodePath.win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

async function statIfExists(path: string): Promise<{ readonly mtimeMs: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function timestampOrFallback(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertSafeSessionId(id: string): void {
  if (isSafeSessionId(id)) return;
  throw new KimiError(ErrorCodes.SESSION_ID_INVALID, 'Session id contains unsupported path characters');
}

function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

function compareSessionSummary(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
