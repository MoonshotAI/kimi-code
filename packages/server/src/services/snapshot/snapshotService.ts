/**
 * `SnapshotService` — server-layer reader for `GET /sessions/{sid}/snapshot`.
 *
 * **Why this exists** (production p99 was 5s+):
 *
 * The legacy snapshot path called `ISessionService.get(sid)` + `IMessageService.list(sid, ...)`,
 * both of which funnel through `core.rpc.listSessions({})` (`SessionStore.listAll` —
 * O(N) over every session directory on disk) and `resumeSession` (heavy: replays
 * the wire log into agent-core memory, plugins, MCP, runtime). For the snapshot
 * READ path none of that is needed: we just want the session metadata + the
 * message transcript + the live in-flight turn + pending approvals/questions.
 *
 * **New flow**:
 *   1. `SessionStore.get(sid)`        — O(1) index lookup, not listAll.
 *   2. read `<sessionDir>/state.json` (mtime-cached via SessionStore).
 *   3. `readWireTranscript(...)`      — LRU keyed on (size, mtimeMs).
 *   4. `broadcast.getSnapshotState`   — in-memory, sub-ms.
 *   5. `approval/question.listPending` — server in-memory maps.
 *   6. `computeStatus(sid)`           — replicates `SessionService._computeStatus`
 *                                       via a private event-bus subscriber.
 *
 * No `core.rpc.*` calls. No `resumeSession`. Lag between `as_of_seq` (broadcast
 * counter) and the wire file's last record is reconciled by the existing
 * client-side WS subscribe-from-seq replay.
 *
 * **Transcript LRU invariants** — see `MessageService` for the same pattern:
 *
 *   - Hit requires EXACT match on both `size` and `mtimeMs`.
 *   - `info.size < cached.size` → cache.delete then reparse. Wire IS NOT
 *     pure append-only: `Persistence.rewrite()` rewrites with `'w'` mode for
 *     compaction migration / `context.clear`.
 *   - `stat` ENOENT → cache miss, return empty entries (brand-new session).
 *   - LRU eviction via delete-then-set.
 *
 * **Session status replication** — this service is a SECOND subscriber to
 * `IEventService.onDidPublish`, maintaining its own `_activeTurns`/`_abortedTurns`
 * Sets in parallel with agent-core's `SessionService._handleBusEvent`. Eager
 * instantiation is REQUIRED (see `start.ts`) — lazy-loading would drop
 * `turn.started` events fired before the first snapshot request.
 */

import { readFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import {
  Disposable,
  IApprovalService,
  IEnvironmentService,
  IEventService,
  ILogService,
  IPromptService,
  IQuestionService,
  readWireTranscript,
  toProtocolMessage,
  toProtocolSession,
  type Event as ProtocolEvent,
  type SessionMeta,
  type SessionSummary,
  type WireTranscript,
} from '@moonshot-ai/agent-core';
import { SessionStore } from '@moonshot-ai/agent-core/session/store';
import type {
  InFlightTurn,
  Message,
  SessionSnapshotResponse,
  SessionStatus,
} from '@moonshot-ai/protocol';

import { IWSBroadcastService } from '#/services/gateway';
import type { ApprovalService } from '#/services/approval/approvalService';
import type { QuestionService } from '#/services/question/questionService';

import { ISnapshotService, SnapshotNotFoundError } from './snapshot';
import { loadSnapshotConfig, type SnapshotConfig } from './snapshotConfig';

const MAIN_AGENT_ID = 'main';
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

interface TranscriptCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly transcript: WireTranscript;
}

interface SessionLocator {
  readonly sessionDir: string;
  readonly summary: SessionSummary;
}

export class SnapshotService extends Disposable implements ISnapshotService {
  readonly _serviceBrand: undefined;

  private readonly _config: SnapshotConfig;
  private readonly _sessionStore: SessionStore;
  private readonly _transcriptCache = new Map<string, TranscriptCacheEntry>();

  // Mirrored from agent-core SessionService — populated by event-bus subscription.
  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();

  constructor(
    @IEnvironmentService private readonly envService: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
    @IEventService eventService: IEventService,
    @IWSBroadcastService private readonly broadcast: IWSBroadcastService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
    @IPromptService private readonly promptService: IPromptService,
  ) {
    super();
    this._config = loadSnapshotConfig();
    this._sessionStore = new SessionStore(this.envService.homeDir);
    this._register(eventService.onDidPublish((event) => this._handleBusEvent(event)));
  }

  async read(sid: string): Promise<SessionSnapshotResponse> {
    const startMs = Date.now();
    let cacheTag: 'hit' | 'miss' | 'shrink_invalidate' | 'enoent' = 'miss';

    const locator = await this._locateSession(sid);

    const [snapState, transcriptResult] = await Promise.all([
      this.broadcast.getSnapshotState(sid),
      this._readTranscriptCached(sid, locator.sessionDir),
    ]);
    cacheTag = transcriptResult.tag;

    const sessionCreatedAtMs = locator.summary.createdAt;
    const items = this._buildMessages(sid, sessionCreatedAtMs, transcriptResult.transcript);
    const sliced = items.length > SNAPSHOT_MESSAGE_PAGE_SIZE
      ? items.slice(items.length - SNAPSHOT_MESSAGE_PAGE_SIZE)
      : items;
    const hasMore = items.length > SNAPSHOT_MESSAGE_PAGE_SIZE;

    const sessionMeta = await this._tryReadStateMeta(locator.sessionDir);
    const session = toProtocolSession(locator.summary, sessionMeta);
    session.status = this._computeStatus(sid);

    const inFlightTurn = this._attachPromptIdToInFlight(sid, snapState.inFlightTurn);

    const approvals = (this.approvalService as ApprovalService).listPending(sid);
    const questions = (this.questionService as QuestionService).listPending(sid);

    const durationMs = Date.now() - startMs;
    this.logger.info(
      {
        sid,
        duration_ms: durationMs,
        cache: cacheTag,
        transcript_entries: transcriptResult.transcript.entries.length,
        wire_bytes: transcriptResult.wireBytes,
      },
      'snapshot.read',
    );

    return {
      as_of_seq: snapState.seq,
      epoch: snapState.epoch,
      session,
      messages: { items: sliced, has_more: hasMore },
      in_flight_turn: inFlightTurn,
      subagents: snapState.subagents,
      pending_approvals: [...approvals],
      pending_questions: [...questions],
    };
  }

  private async _locateSession(sid: string): Promise<SessionLocator> {
    try {
      const summary = await this._sessionStore.get(sid);
      return { sessionDir: summary.sessionDir, summary };
    } catch {
      throw new SnapshotNotFoundError(sid);
    }
  }

  /**
   * Read `state.json` and parse it into a `SessionMeta`-shaped object good
   * enough for `toProtocolSession`. Best-effort — corruption / missing file
   * degrades to `undefined`, matching `SessionService.tryGetMeta`.
   */
  private async _tryReadStateMeta(sessionDir: string): Promise<SessionMeta | undefined> {
    try {
      const raw = await readFile(path.join(sessionDir, 'state.json'), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as SessionMeta;
    } catch {
      return undefined;
    }
  }

  private _buildMessages(
    sid: string,
    sessionCreatedAtMs: number,
    transcript: WireTranscript,
  ): Message[] {
    let previousMs = Number.NEGATIVE_INFINITY;
    return transcript.entries.map((entry, idx) => {
      const baseMs = entry.time ?? sessionCreatedAtMs + idx;
      const createdAtMs = Math.max(previousMs + 1, baseMs);
      previousMs = createdAtMs;
      return toProtocolMessage(sid, idx, entry.message, sessionCreatedAtMs, createdAtMs);
    });
  }

  private async _readTranscriptCached(
    sid: string,
    sessionDir: string,
  ): Promise<{
    transcript: WireTranscript;
    tag: 'hit' | 'miss' | 'shrink_invalidate' | 'enoent';
    wireBytes: number;
  }> {
    const wirePath = path.join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
    let info: { size: number; mtimeMs: number } | undefined;
    try {
      info = await fsStat(wirePath);
    } catch {
      info = undefined;
    }
    if (info === undefined) {
      // Fresh session — no wire file yet. Drop any stale cache entry so the
      // first write doesn't get masked.
      this._transcriptCache.delete(sid);
      return {
        transcript: { entries: [], foldedLength: 0 },
        tag: 'enoent',
        wireBytes: 0,
      };
    }

    const cached = this._transcriptCache.get(sid);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      this._transcriptCache.delete(sid);
      this._transcriptCache.set(sid, cached);
      return { transcript: cached.transcript, tag: 'hit', wireBytes: info.size };
    }

    const tag: 'miss' | 'shrink_invalidate' =
      cached !== undefined && info.size < cached.size ? 'shrink_invalidate' : 'miss';
    if (cached !== undefined) {
      this._transcriptCache.delete(sid);
    }

    const transcript = await readWireTranscript(sessionDir, MAIN_AGENT_ID);
    this._transcriptCache.set(sid, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      transcript,
    });
    while (this._transcriptCache.size > this._config.cacheLimit) {
      const oldest = this._transcriptCache.keys().next().value;
      if (oldest === undefined) break;
      this._transcriptCache.delete(oldest);
    }
    return { transcript, tag, wireBytes: info.size };
  }

  /**
   * Replicates `SessionService._computeStatus`. Priority:
   *   1. awaiting_approval — pending approvals exist
   *   2. awaiting_question — pending questions exist
   *   3. running           — active prompt or active turn
   *   4. aborted           — last turn ended as cancelled/failed
   *   5. idle              — everything else
   */
  private _computeStatus(sid: string): SessionStatus {
    if ((this.approvalService as ApprovalService).listPending(sid).length > 0) {
      return 'awaiting_approval';
    }
    if ((this.questionService as QuestionService).listPending(sid).length > 0) {
      return 'awaiting_question';
    }
    if (
      this.promptService.getCurrentPromptId(sid) !== undefined ||
      this._activeTurns.has(sid)
    ) {
      return 'running';
    }
    if (this._abortedTurns.has(sid)) {
      return 'aborted';
    }
    return 'idle';
  }

  /**
   * Mirrors `SessionService._handleBusEvent`, narrowed to the three event
   * types that mutate `_activeTurns` / `_abortedTurns`. No `_emitStatusChanged`
   * replica — we only READ status on demand.
   */
  private _handleBusEvent(event: ProtocolEvent): void {
    const type = (event as { type?: string }).type;
    const sessionId = (event as { sessionId?: string }).sessionId;
    if (sessionId === undefined || sessionId === '' || type === undefined) return;

    switch (type) {
      case 'turn.started': {
        this._activeTurns.add(sessionId);
        this._abortedTurns.delete(sessionId);
        return;
      }
      case 'turn.ended': {
        this._activeTurns.delete(sessionId);
        const reason = (event as { reason?: string }).reason;
        if (reason === 'cancelled' || reason === 'failed' || reason === 'blocked') {
          this._abortedTurns.add(sessionId);
        } else {
          this._abortedTurns.delete(sessionId);
        }
        return;
      }
      case 'prompt.submitted': {
        this._abortedTurns.delete(sessionId);
        return;
      }
      default:
        return;
    }
  }

  private _attachPromptIdToInFlight(
    sid: string,
    inFlightTurn: InFlightTurn | null,
  ): InFlightTurn | null {
    if (inFlightTurn === null) return null;
    const currentPromptId = this.promptService.getCurrentPromptId(sid);
    if (currentPromptId !== undefined) {
      inFlightTurn.current_prompt_id = currentPromptId;
    }
    return inFlightTurn;
  }
}
