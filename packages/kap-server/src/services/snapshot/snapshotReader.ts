/**
 * `SnapshotReader` — server-layer disk reader for `GET /sessions/{sid}/snapshot`
 * (`KIMI_SNAPSHOT_READER=auto`, the default).
 *
 * Reads `<homeDir>/sessions/<workspaceId>/<sid>/state.json` and
 * `…/agents/main/wire.jsonl` directly, bypassing
 * `ISessionLifecycleService.resume` (DI-scope materialization, MCP connect,
 * full wire replay). The transcript is reduced from the `context.*` records
 * with `reduceContextTranscript`, which mirrors the live reducers EXCEPT that
 * `context.apply_compaction` keeps the full history and appends a summary
 * marker instead of dropping the compacted prefix — the same full-transcript
 * view v1 serves (so compacted-away assistant replies stay visible after a
 * later undo). `(size, mtimeMs)` transcript cache and the watermark both come
 * from in-memory state, keeping warm reads sub-ms.
 *
 * Pending approvals/questions, the live status, and `current_prompt_id` are
 * only available while the session is live; for a cold session they correctly
 * resolve to empty / `'idle'` (a cold session owns no runtime interaction).
 */

import { readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentPromptService,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  IWorkspaceService,
  normalizeSessionMeta,
  reduceContextTranscript,
  toProtocolMessage,
  type ContextMessage,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';

import { toWireApproval } from '../../routes/approvals';
import { toWireQuestion } from '../../routes/questions';
import { resolveSessionFacts, toWireSession } from '../../routes/sessions';
import { type SessionEventBroadcaster } from '../../transport/ws/v1/sessionEventBroadcaster';
import type { InFlightTurn, SessionSnapshotResponse } from '../../protocol/rest-snapshot';
import { SnapshotNotFoundError } from './snapshot';
import type { ISnapshotReader } from './snapshot';
import { type SnapshotConfig } from './snapshotConfig';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const BLOBS_DIR = 'blobs';
const MAIN_AGENT_ID = 'main';
const STATE_FILE = 'state.json';
const WIRE_FILE = 'wire.jsonl';
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;
const BLOBREF_PROTOCOL = 'blobref:';
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface SnapshotReaderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface SnapshotReaderDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
  readonly logger: SnapshotReaderLogger;
  readonly config: SnapshotConfig;
}

interface TranscriptCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly messages: ContextMessage[];
  readonly times: readonly (number | undefined)[];
}

interface LocatedSession {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly meta: SessionMeta;
}

export class SnapshotReader implements ISnapshotReader {
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(private readonly deps: SnapshotReaderDeps) {}

  async read(sid: string): Promise<SessionSnapshotResponse> {
    const startMs = Date.now();
    const { core, broadcaster, logger } = this.deps;

    const located = await this.locateSession(sid);

    const [snapState, transcript] = await Promise.all([
      broadcaster.getSnapshotState(sid),
      this.readTranscriptCached(sid, located.sessionDir),
    ]);

    const full = transcript.messages;
    const hasMore = full.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
    const offset = hasMore ? full.length - SNAPSHOT_MESSAGE_PAGE_SIZE : 0;
    const page = hasMore ? full.slice(offset) : full;
    await this.rehydrateBlobRefs(page, join(located.sessionDir, AGENTS_DIR, MAIN_AGENT_ID, BLOBS_DIR));
    // `created_at` prefers the real per-record time stamped onto wire.jsonl at
    // dispatch; records predating the stamp (or the `metadata` envelope) fall
    // back to the synthesized `session.createdAt + index`, clamped so the
    // page stays strictly increasing (mirrors `MessageLegacyService.list`).
    let previousMs = Number.NEGATIVE_INFINITY;
    const items = page.map((msg, i) => {
      const index = offset + i;
      const baseMs = transcript.times[index] ?? located.meta.createdAt + index;
      const createdAtMs = Math.max(previousMs + 1, baseMs);
      previousMs = createdAtMs;
      return toProtocolMessage(sid, index, msg, located.meta.createdAt, createdAtMs);
    });

    const live = core.accessor.get(ISessionLifecycleService).get(sid);
    const session = toWireSession(
      { ...located.meta, workspaceId: located.workspaceId },
      located.cwd,
      resolveSessionFacts(core, sid),
    );

    const inFlightTurn = this.attachCurrentPromptId(sid, live, snapState.inFlightTurn);
    const { approvals, questions } = this.readPending(sid, live);

    logger.info(
      {
        sid,
        duration_ms: Date.now() - startMs,
        cache: transcript.tag,
        transcript_entries: full.length,
        wire_bytes: transcript.wireBytes,
      },
      'snapshot.read',
    );

    return {
      as_of_seq: snapState.seq,
      epoch: snapState.epoch,
      session,
      messages: { items, has_more: hasMore },
      in_flight_turn: inFlightTurn,
      subagents: snapState.subagents,
      pending_approvals: approvals,
      pending_questions: questions,
    };
  }

  /**
   * Resolve `(workspaceId, sessionDir, cwd, meta)` for `sid`. Mirrors the
   * legacy route's 404 conditions: unknown to the index, or workspace no longer
   * registered (cwd is unrecoverable and would produce an invalid `Session`).
   */
  private async locateSession(sid: string): Promise<LocatedSession> {
    const { core, homeDir } = this.deps;
    const summary = await core.accessor.get(ISessionIndex).get(sid);
    if (summary === undefined) throw new SnapshotNotFoundError(sid);
    const workspace = await core.accessor.get(IWorkspaceService).get(summary.workspaceId);
    if (workspace === undefined) throw new SnapshotNotFoundError(sid);

    const sessionDir = join(homeDir, SESSIONS_ROOT, summary.workspaceId, sid);
    const rawMeta = await this.readStateMeta(join(sessionDir, STATE_FILE));
    const meta = normalizeSessionMeta((rawMeta ?? summary) as SessionMeta, sid);
    return { workspaceId: summary.workspaceId, cwd: workspace.root, sessionDir, meta };
  }

  /** Best-effort `state.json` read; missing / corrupt degrades to `undefined`. */
  private async readStateMeta(statePath: string): Promise<SessionMeta | undefined> {
    try {
      const raw = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as SessionMeta;
    } catch {
      return undefined;
    }
  }

  private async readTranscriptCached(
    sid: string,
    sessionDir: string,
  ): Promise<{
    messages: ContextMessage[];
    times: readonly (number | undefined)[];
    tag: 'hit' | 'miss' | 'shrink_invalidate' | 'enoent';
    wireBytes: number;
  }> {
    const wirePath = join(sessionDir, AGENTS_DIR, MAIN_AGENT_ID, WIRE_FILE);
    let info: { size: number; mtimeMs: number } | undefined;
    try {
      info = await fsStat(wirePath);
    } catch {
      info = undefined;
    }
    if (info === undefined) {
      this.transcriptCache.delete(sid);
      return { messages: [], times: [], tag: 'enoent', wireBytes: 0 };
    }

    const cached = this.transcriptCache.get(sid);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      // LRU touch.
      this.transcriptCache.delete(sid);
      this.transcriptCache.set(sid, cached);
      return { messages: cached.messages, times: cached.times, tag: 'hit', wireBytes: info.size };
    }

    const tag: 'miss' | 'shrink_invalidate' =
      cached !== undefined && info.size < cached.size ? 'shrink_invalidate' : 'miss';
    if (cached !== undefined) this.transcriptCache.delete(sid);

    const records = await readWireRecords(wirePath);
    const { entries, times } = reduceContextTranscript(records);
    const messages = [...entries];
    this.transcriptCache.set(sid, { size: info.size, mtimeMs: info.mtimeMs, messages, times });
    while (this.transcriptCache.size > this.deps.config.cacheLimit) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest === undefined) break;
      this.transcriptCache.delete(oldest);
    }
    return { messages, times, tag, wireBytes: info.size };
  }

  private attachCurrentPromptId(
    sid: string,
    live: ReturnType<ISessionLifecycleService['get']>,
    inFlightTurn: InFlightTurn | null,
  ): InFlightTurn | null {
    if (inFlightTurn === null || live === undefined) return inFlightTurn;
    const main = live.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    if (main === undefined) return inFlightTurn;
    let currentPromptId: string | undefined;
    try {
      currentPromptId = main.accessor.get(IAgentPromptService).list().active?.id;
    } catch {
      return inFlightTurn;
    }
    if (currentPromptId === undefined) return inFlightTurn;
    return { ...inFlightTurn, current_prompt_id: currentPromptId };
  }

  private readPending(
    sid: string,
    live: ReturnType<ISessionLifecycleService['get']>,
  ): { approvals: ReturnType<typeof toWireApproval>[]; questions: ReturnType<typeof toWireQuestion>[] } {
    if (live === undefined) return { approvals: [], questions: [] };
    const interaction = live.accessor.get(ISessionInteractionService);
    return {
      approvals: interaction.listPending('approval').map((i) => toWireApproval(i, sid)),
      questions: interaction.listPending('question').map((i) => toWireQuestion(i, sid)),
    };
  }

  /** Rehydrate `blobref:<mime>;<sha256>` media URLs from `<agentDir>/blobs/<hash>`. Mirrors v1; unresolvable refs become `[media missing]`. */
  private async rehydrateBlobRefs(messages: readonly ContextMessage[], blobsDir: string): Promise<void> {
    const cache = new Map<string, string | undefined>();
    for (const message of messages) {
      for (const part of message.content) {
        for (const value of Object.values(part as unknown as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          const media = value as { url?: unknown };
          if (typeof media.url !== 'string' || !media.url.startsWith(BLOBREF_PROTOCOL)) continue;
          media.url = (await resolveBlobRef(media.url, blobsDir, cache)) ?? MISSING_MEDIA_PLACEHOLDER;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure reduction + parsing helpers
// ---------------------------------------------------------------------------

interface ContextRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Parse a `wire.jsonl` file. A torn final line (crash mid-flush) is dropped;
 * corruption anywhere else throws so the route surfaces 50001. The leading
 * `metadata` envelope and any non-`context.*` record are returned as-is and
 * filtered by the reducer's `default` branch.
 */
export async function readWireRecords(wirePath: string): Promise<ContextRecord[]> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: ContextRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as ContextRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break;
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return records;
}

async function resolveBlobRef(
  url: string,
  blobsDir: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (cache.has(url)) return cache.get(url);
  let resolved: string | undefined;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx !== -1) {
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (/^[0-9a-f]{16,}$/i.test(hash)) {
      const payload = await readFile(join(blobsDir, hash)).catch(() => undefined);
      if (payload !== undefined) {
        resolved = `data:${mimeType};base64,${payload.toString('base64')}`;
      }
    }
  }
  cache.set(url, resolved);
  return resolved;
}
