/**
 * `MessageService` — implementation of `IMessageService`.
 *
 * History source: the agent's `wire.jsonl` record log, NOT the live
 * `getContext().history`. The live history is the model's CURRENT context —
 * after a compaction it collapses into `[compaction_summary, ...tail]`, which
 * made `GET /sessions/{sid}/messages` lose everything before the fold. The
 * wire log keeps every record, so `readWireTranscript` rebuilds the full
 * transcript (the same view the TUI shows after resume). See
 * `./transcript.ts` for the exact mirrored semantics.
 *
 * Live-tail merge: records reach disk through an async flush queue, so a
 * request hitting an actively-running session may find the wire file a few
 * records behind memory. `WireTranscript.foldedLength` is what the live
 * history length WOULD be from the file's records; anything beyond it in the
 * real `getContext().history` is the unflushed tail and gets appended.
 *
 * Fallback: any transcript read/parse failure degrades to the previous
 * behavior (live context history) instead of failing the endpoint.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { SessionSummary } from '../../rpc';
import type {
  Message,
  PageResponse,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  IMessageService,
  MessageNotFoundError,
  parseMessageId,
  toProtocolMessage,
  type MessageListQuery,
} from './message';
import {
  readWireTranscript,
  type TranscriptEntry,
  type WireTranscript,
} from './transcript';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Agent id used for all session-scoped getContext calls (matches agent-core convention; see `core-impl.ts:788`). */
const MAIN_AGENT_ID = 'main';
/** Parsed wire transcripts kept in memory (one per session, LRU). */
const TRANSCRIPT_CACHE_LIMIT = 8;

interface TranscriptCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly transcript: WireTranscript;
}

export class MessageService extends Disposable implements IMessageService {
  readonly _serviceBrand: undefined;

  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const all = await this._getProtocolMessages(sid);
    // SCHEMAS §1.3: "缺省返回最近 N 条 (created_at desc)" — newest first.
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot.
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot.
      slice = desc.slice(0, pivotIndex);
    } else {
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Role filter is applied AFTER pagination — see header.
    const filtered =
      query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sid: string, mid: string): Promise<Message> {
    // Resolve the session first: unknown sid must map to 40401 even when the
    // message id is malformed or belongs to another session (40403).
    const all = await this._getProtocolMessages(sid);
    const parsed = parseMessageId(mid);
    if (parsed === undefined || parsed.sessionId !== sid) {
      throw new MessageNotFoundError(sid, mid);
    }
    const entry = all[parsed.index];
    if (entry === undefined) {
      throw new MessageNotFoundError(sid, mid);
    }
    return entry;
  }

  /**
   * Confirms the session exists and returns its summary (for the timestamp
   * base). Throws `SessionNotFoundError` (→ 40401) on miss.
   */
  private async _requireSession(sid: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === sid);
    if (summary === undefined) {
      throw new SessionNotFoundError(sid);
    }
    return summary;
  }

  /**
   * Full transcript mapped to protocol messages. Ids stay index-derived;
   * `created_at` uses the wire record time when known, nudged to stay
   * strictly increasing so cursor consumers keep a stable total order.
   */
  private async _getProtocolMessages(sid: string): Promise<Message[]> {
    const summary = await this._requireSession(sid);
    const entries = await this._getTranscriptEntries(sid, summary);
    let previousMs = Number.NEGATIVE_INFINITY;
    return entries.map((entry, idx) => {
      const baseMs = entry.time ?? summary.createdAt + idx;
      const createdAtMs = Math.max(previousMs + 1, baseMs);
      previousMs = createdAtMs;
      return toProtocolMessage(sid, idx, entry.message, summary.createdAt, createdAtMs);
    });
  }

  /**
   * Wire transcript + unflushed live tail; falls back to the live context
   * history alone when the wire file is unreadable. Ordering matters: the
   * file is read BEFORE `getContext` so the in-memory history is always at
   * least as new as the file snapshot and the tail merge can only append.
   */
  private async _getTranscriptEntries(
    sid: string,
    summary: SessionSummary,
  ): Promise<readonly TranscriptEntry[]> {
    await this._resumeSession(sid);
    const transcript = await this._readTranscriptCached(sid, summary.sessionDir);
    const context = await this.core.rpc.getContext({
      sessionId: sid,
      agentId: MAIN_AGENT_ID,
    });
    if (transcript === undefined) {
      return context.history.map((message) => ({ message }));
    }
    if (context.history.length <= transcript.foldedLength) {
      return transcript.entries;
    }
    const liveTail: TranscriptEntry[] = context.history
      .slice(transcript.foldedLength)
      .map((message) => ({ message }));
    return [...transcript.entries, ...liveTail];
  }

  private async _resumeSession(sid: string): Promise<void> {
    try {
      await this.core.rpc.resumeSession({ sessionId: sid });
    } catch {
      throw new SessionNotFoundError(sid);
    }
  }

  /**
   * Read + reduce the wire log, cached on `(size, mtimeMs)` so repeated
   * pagination calls do not re-parse an unchanged file. Returns `undefined`
   * when the file is missing or unreadable (caller falls back to live view).
   */
  private async _readTranscriptCached(
    sid: string,
    sessionDir: string,
  ): Promise<WireTranscript | undefined> {
    try {
      const wirePath = path.join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
      const info = await stat(wirePath);
      const cached = this.transcriptCache.get(sid);
      if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        // Refresh LRU position.
        this.transcriptCache.delete(sid);
        this.transcriptCache.set(sid, cached);
        return cached.transcript;
      }
      const transcript = await readWireTranscript(sessionDir, MAIN_AGENT_ID);
      this.transcriptCache.delete(sid);
      this.transcriptCache.set(sid, { size: info.size, mtimeMs: info.mtimeMs, transcript });
      while (this.transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
        const oldest = this.transcriptCache.keys().next().value;
        if (oldest === undefined) break;
        this.transcriptCache.delete(oldest);
      }
      return transcript;
    } catch {
      return undefined;
    }
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IMessageService, MessageService, InstantiationType.Delayed);
