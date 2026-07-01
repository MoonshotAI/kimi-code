/**
 * Wire-transcript reader — rebuilds the FULL message history of a session
 * agent from its `wire.jsonl` record log.
 *
 * Why: `ContextMemory.applyCompaction` rewrites the in-memory history as
 * `[...keptUserMessages, compaction_summary]` (the most recent real user
 * prompts, verbatim within a token budget, followed by a single user-role
 * summary), so `getContext().history` only reflects the model's CURRENT
 * context. The wire log, however, keeps every record. The TUI
 * shows the full transcript on resume because `ReplayBuilder` captures every
 * `pushHistory` during record replay and is never folded by compaction. This
 * module reproduces that exact view for daemon REST consumers (web), without
 * touching agent-core: it re-reduces the `context.*` records with the same
 * semantics as `ContextMemory` restore, except that `context.apply_compaction`
 * INSERTS the summary message in place instead of dropping the compacted
 * prefix.
 *
 * Mirrored agent-core semantics (packages/agent-core/src/agent/context/index.ts):
 *   - `context.append_message`      → append (deferred while a tool exchange is open)
 *   - `context.append_loop_event`   → step.begin/content.part/tool.call mutate the
 *                                     open assistant message; tool.result appends a
 *                                     tool message with the same `<system>` status
 *                                     wrapping as `toolResultOutputForModel`
 *   - `context.apply_compaction`    → keep the full history, append the
 *                                     user-role summary marker (origin
 *                                     `compaction_summary`), and recover
 *                                     `foldedLength` from the recorded
 *                                     `keptUserMessageCount`
 *   - `context.undo`                → remove tail messages exactly like
 *                                     `ContextMemory.undo` (skip injections, stop at
 *                                     compaction summaries / `context.clear` floors)
 *   - `context.clear`               → keep prior messages in the transcript (the TUI
 *                                     replay keeps them too) but reset the folded view
 *
 * Blob refs (`blobref:<mime>;<hash>` URLs offloaded by `BlobStore`) are
 * rehydrated from `<agentDir>/blobs/<hash>` back into data URIs, mirroring
 * `BlobStore.rehydrateParts`.
 *
 * Callers must `resumeSession` BEFORE reading: replay rewrites outdated wire
 * protocol versions in place, so a post-resume read always sees the current
 * record shapes. Reads of an actively-running session can trail the in-memory
 * history by the few records still in the persistence flush queue — compare
 * `foldedLength` with the live `getContext().history` length and append the
 * missing tail (see `MessageService`).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentRecord } from '../../agent/records';
import type { ContextMessage } from '../../agent/context';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  isRealUserInput,
  selectRecentUserMessages,
} from '../../agent/compaction';

type ContentPart = ContextMessage['content'][number];

const BLOBREF_PROTOCOL = 'blobref:';
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

// Status strings must match agent-core's toolResultOutputForModel so the
// transcript renders tool results byte-identically to getContext().history.
const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export interface TranscriptEntry {
  readonly message: ContextMessage;
  /** Wall-clock time of the originating wire record, when present. */
  readonly time?: number | undefined;
}

export interface WireTranscript {
  /** Full message history, compacted prefixes included. */
  readonly entries: readonly TranscriptEntry[];
  /**
   * Length the live (folded) `context.history` would have after these
   * records. Lets callers detect and append a not-yet-flushed live tail.
   */
  readonly foldedLength: number;
}

interface MutableMessage {
  role: ContextMessage['role'];
  content: ContentPart[];
  toolCalls: { type: 'function'; id: string; name: string; arguments: string | null }[];
  toolCallId?: string;
  isError?: boolean | undefined;
  origin?: ContextMessage['origin'];
}

interface MutableEntry {
  message: MutableMessage;
  time?: number | undefined;
}

/**
 * Reduce wire records into the full transcript. Pure (no I/O); exported for
 * tests. Unknown or non-context records are ignored — only `context.*`
 * records mutate history in agent-core, every other mutation path logs one.
 */
export function reduceWireRecords(records: Iterable<AgentRecord>): {
  entries: TranscriptEntry[];
  foldedLength: number;
} {
  const transcript: MutableEntry[] = [];
  /** What `context.history.length` would be right now (post-folding). */
  let foldedLength = 0;
  /** Transcript index `context.undo` may not cross (set by `context.clear`). */
  let clearFloor = 0;
  const openSteps = new Map<string, MutableEntry>();
  const pendingToolResultIds = new Set<string>();
  let deferred: MutableEntry[] = [];

  const push = (...entries: MutableEntry[]): void => {
    transcript.push(...entries);
    foldedLength += entries.length;
  };
  const flushDeferredIfToolExchangeClosed = (): void => {
    if (pendingToolResultIds.size > 0 || deferred.length === 0) return;
    push(...deferred);
    deferred = [];
  };
  // ContextMemory closes these during replay without persisting the synthetic
  // result, so the reducer must reconstruct it to keep foldedLength aligned.
  const closePendingToolResults = (time: number | undefined): void => {
    if (pendingToolResultIds.size === 0) return;
    const interruptedToolCallIds = [...pendingToolResultIds];
    for (const toolCallId of interruptedToolCallIds) {
      push({
        message: {
          role: 'tool',
          content: toolResultContent({
            output: TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
            isError: true,
          }),
          toolCalls: [],
          toolCallId,
          isError: true,
        },
        time,
      });
      pendingToolResultIds.delete(toolCallId);
    }
    flushDeferredIfToolExchangeClosed();
  };
  const resetOpenState = (): void => {
    openSteps.clear();
    pendingToolResultIds.clear();
    deferred = [];
  };

  const applyLoopEvent = (event: LoopRecordedEvent, time: number | undefined): void => {
    switch (event.type) {
      case 'step.begin': {
        closePendingToolResults(time);
        const entry: MutableEntry = {
          message: { role: 'assistant', content: [], toolCalls: [] },
          time,
        };
        push(entry);
        openSteps.set(event.uuid, entry);
        return;
      }
      case 'step.end': {
        openSteps.delete(event.uuid);
        flushDeferredIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        // Lenient where ContextMemory throws: a dangling part in a damaged
        // file should not take the whole messages endpoint down.
        openSteps.get(event.stepUuid)?.message.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = openSteps.get(event.stepUuid);
        if (openStep === undefined) return;
        openStep.message.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        });
        pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        // Drop a result for an id not awaiting one (already closed in place, or
        // its call is gone) — mirrors ContextMemory.
        if (!pendingToolResultIds.has(event.toolCallId)) return;
        push({
          message: {
            role: 'tool',
            content: toolResultContent(event.result),
            toolCalls: [],
            toolCallId: event.toolCallId,
            isError: event.result.isError,
          },
          time,
        });
        pendingToolResultIds.delete(event.toolCallId);
        flushDeferredIfToolExchangeClosed();
        return;
      }
    }
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    let removedUserCount = 0;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const message = transcript[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      foldedLength = Math.max(0, foldedLength - 1);
      if (isRealUserInput(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }
    resetOpenState();
  };

  for (const record of records) {
    switch (record.type) {
      case 'context.append_message': {
        const entry: MutableEntry = {
          message: record.message as MutableMessage,
          time: record.time,
        };
        if (pendingToolResultIds.size > 0) {
          deferred.push(entry);
        } else {
          push(entry);
        }
        break;
      }
      case 'context.append_loop_event':
        applyLoopEvent(record.event, record.time);
        break;
      case 'context.apply_compaction': {
        // Mirrors ContextMemory.applyCompaction: the live context becomes the
        // most recent user messages followed by a user-role summary. The
        // transcript keeps the full history and appends the summary marker;
        // foldedLength tracks the post-compaction live context length.
        transcript.push({
          message: {
            role: 'user',
            content: [{ type: 'text', text: record.summary }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          time: record.time,
        });
        // Prefer the kept-user count recorded by the live
        // ContextMemory.applyCompaction. Re-deriving it from the full
        // transcript would diverge from the live context: the transcript still
        // holds the untruncated originals of messages the live context may
        // have truncated, and (after a clear) messages the live context no
        // longer has. Only fall back to re-deriving for legacy wire records
        // that predate the field.
        if (record.keptUserMessageCount !== undefined) {
          foldedLength = record.keptUserMessageCount + 1;
        } else if (record.compactedCount < foldedLength) {
          // Legacy record (predates keptUserMessageCount) that kept
          // history.slice(compactedCount) verbatim. Mirror ContextMemory's
          // legacy restore ([summary, ...tail]): `foldedLength` here still holds
          // the pre-compaction live length, so the post-compaction length is the
          // summary plus the tail kept after compactedCount. Re-deriving the
          // kept-user count instead would diverge from the live context (and
          // make MessageService mis-handle the messages endpoint for old sessions).
          foldedLength = 1 + (foldedLength - record.compactedCount);
        } else {
          // Legacy record whose compactedCount covered the whole live history (no
          // tail, matching live restore's `compactedCount < length` guard): fall
          // back to the new kept-user + summary derivation. Derive only from
          // entries at or after `clearFloor` — the live ContextMemory rebuilds
          // `_history` from the post-`/clear` messages only, so counting pre-clear
          // prompts here would overstate foldedLength and make MessageService skip
          // unflushed live tail messages for old sessions compacted after a clear.
          const keptUserMessages = selectRecentUserMessages(
            collectCompactableUserMessages(
              transcript.slice(clearFloor).map((entry) => entry.message),
            ),
            COMPACT_USER_MESSAGE_MAX_TOKENS,
          );
          foldedLength = keptUserMessages.length + 1;
        }
        // Drop any open tool exchange and deferred messages exactly like
        // ContextMemory.applyCompaction: late tool results become orphans and
        // deferred injections are not rebuilt, so pending ids must not strand
        // later appends in `deferred`.
        resetOpenState();
        break;
      }
      case 'context.undo':
        applyUndo(record.count);
        break;
      case 'context.clear':
        clearFloor = transcript.length;
        foldedLength = 0;
        resetOpenState();
        break;
      default:
        break;
    }
  }

  return { entries: transcript as TranscriptEntry[], foldedLength };
}

/** Mirrors agent-core's `toolResultOutputForModel` + `createToolMessage`. */
function toolResultContent(result: ExecutableToolResult): ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    let text: string;
    if (result.isError === true) {
      if (output.length === 0) text = TOOL_EMPTY_ERROR_STATUS;
      else if (output.trimStart().startsWith('<system>ERROR:')) text = output;
      else text = `${TOOL_ERROR_STATUS}\n${output}`;
    } else {
      text =
        output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT
          ? TOOL_EMPTY_STATUS
          : output;
    }
    return [{ type: 'text', text }];
  }
  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return [...output];
}

/**
 * Parse a `wire.jsonl` file. A torn FINAL line (crash mid-flush) is dropped,
 * matching `FileSystemAgentRecordPersistence.read`; corruption anywhere else
 * throws so the caller can fall back to the live context view.
 */
export async function readWireRecords(wirePath: string): Promise<AgentRecord[]> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: AgentRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as AgentRecord);
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

/**
 * Rebuild the full transcript for one session agent. The caller is expected
 * to have resumed the session first (wire protocol migration — see header).
 */
export async function readWireTranscript(
  sessionDir: string,
  agentId: string,
): Promise<WireTranscript> {
  const agentDir = path.join(sessionDir, 'agents', agentId);
  const records = await readWireRecords(path.join(agentDir, 'wire.jsonl'));
  const { entries, foldedLength } = reduceWireRecords(records);
  await rehydrateBlobRefs(entries, path.join(agentDir, 'blobs'));
  return { entries, foldedLength };
}

/**
 * Replace `blobref:<mime>;<hash>` media URLs with `data:` URIs read from the
 * agent's blob store, mirroring `BlobStore.rehydrateParts`. Unresolvable refs
 * become `[media missing]`, same as agent-core.
 */
async function rehydrateBlobRefs(
  entries: readonly TranscriptEntry[],
  blobsDir: string,
): Promise<void> {
  const cache = new Map<string, string | undefined>();
  for (const entry of entries) {
    for (const part of entry.message.content) {
      for (const value of Object.values(part as unknown as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        const media = value as { url?: unknown };
        if (typeof media.url !== 'string' || !media.url.startsWith(BLOBREF_PROTOCOL)) {
          continue;
        }
        media.url = (await resolveBlobRef(media.url, blobsDir, cache)) ?? MISSING_MEDIA_PLACEHOLDER;
      }
    }
  }
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
    // Hashes are hex digests written by BlobStore; reject anything that could
    // escape the blobs directory.
    if (/^[0-9a-f]{16,}$/i.test(hash)) {
      const payload = await readFile(path.join(blobsDir, hash)).catch(() => undefined);
      if (payload !== undefined) {
        resolved = `data:${mimeType};base64,${payload.toString('base64')}`;
      }
    }
  }
  cache.set(url, resolved);
  return resolved;
}
