/**
 * Staleness detection for the interactive TUI transcript vs the session's
 * on-disk wire journal.
 *
 * The TUI renders a pure in-memory transcript while the engine persists every
 * op to `<sessionDir>/agents/<agentId>/wire.jsonl`. External clients (ACP
 * attach, mobile) can append turns to that journal without the TUI ever seeing
 * an event, so the user would keep typing against a stale context and silently
 * fork the session into two divergent histories. These helpers let the TUI
 * compare the newest user-turn it has rendered against the journal's newest
 * user-turn before accepting the next input.
 *
 * The comparison deliberately keys on `turn.prompt` records rather than any
 * timestamped record: compaction, plan-mode toggles and config writes advance
 * the journal tail without opening a new conversational turn, so they must not
 * count as external activity. `turn.prompt` is the wire's authoritative
 * user-turn boundary (see `agent-core-v2/src/agent/loop/turnOps.ts`).
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Record types that open a new conversational turn in the wire journal. */
const TURN_BOUNDARY_TYPES = new Set(['turn.prompt']);

/** Path of an agent's persisted journal inside a session directory. */
export function agentWirePath(sessionDir: string, agentId: string): string {
  return join(sessionDir, 'agents', agentId, 'wire.jsonl');
}

/** Size of the backward scan windows used to locate the newest turn. */
const WIRE_TAIL_READ_BYTES = 64 * 1024;

/**
 * Extract the newest user-turn (`turn.prompt`) timestamp from a chunk read off
 * the tail of a JSONL wire journal.
 *
 * A tail chunk may begin mid-record (the read boundary split a line); the scan
 * runs from the last line upward, skipping fragments that fail to parse and
 * non-boundary records. Returns `undefined` when the chunk holds no complete
 * `turn.prompt` record with a numeric `time`.
 */
export function lastTurnBoundaryTimeInChunk(chunk: string): number | undefined {
  const lines = chunk.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let record: { type?: unknown; time?: unknown };
    try {
      record = JSON.parse(line) as { type?: unknown; time?: unknown };
    } catch {
      // Fragment from the read boundary — keep scanning upward.
      continue;
    }
    if (typeof record.time === 'number' && TURN_BOUNDARY_TYPES.has(record.type as string)) {
      return record.time;
    }
  }
  return undefined;
}

/**
 * True when the wire journal has a user-turn newer than the newest turn the
 * TUI has rendered — i.e. an external client appended a turn the user never
 * saw. Fails open (false) whenever either side is unknown.
 */
export function wireTailAheadOfTranscript(opts: {
  readonly transcriptTipTime: number | undefined;
  readonly wireTailTime: number | undefined;
}): boolean {
  const { transcriptTipTime, wireTailTime } = opts;
  if (transcriptTipTime === undefined || wireTailTime === undefined) return false;
  return wireTailTime > transcriptTipTime;
}

/**
 * Read the newest user-turn timestamp of an agent's `wire.jsonl`.
 *
 * Walks backward from the journal tail in {@link WIRE_TAIL_READ_BYTES} windows
 * until a `turn.prompt` boundary is found or the start of the file is reached,
 * so a single external turn whose response/tool output spans more than one
 * window cannot hide its prompt boundary. A record split across a read
 * boundary is reassembled before scanning: the fragment at the top of each
 * window is the tail half of a record whose head lives at the end of the next
 * (older) window, and the two are joined back into one line.
 *
 * Failures (missing session dir, unreadable journal) degrade to `undefined`
 * so the staleness guard always fails open rather than blocking the user on a
 * corrupt file.
 */
export async function readWireTurnBoundaryTime(
  sessionDir: string,
  agentId: string,
): Promise<number | undefined> {
  try {
    const file = await open(agentWirePath(sessionDir, agentId), 'r');
    try {
      const { size } = await file.stat();
      if (size <= 0) return undefined;
      let offset = size;
      // Tail half of the record split by the last read boundary; its head is
      // the final line of the next (older) window.
      let carry = '';
      while (offset > 0) {
        const start = Math.max(0, offset - WIRE_TAIL_READ_BYTES);
        const length = offset - start;
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, start);
        const chunk = buffer.toString('utf8');
        const firstNl = chunk.indexOf('\n');
        if (firstNl >= 0) {
          // The first line may be the tail half of a split record; the rest
          // are complete. Appending the carried tail to the window's own last
          // line (the head half) reassembles the split record, which is the
          // newest line this window contributes and is scanned first.
          const rest = chunk.slice(firstNl + 1);
          const time = lastTurnBoundaryTimeInChunk(rest + carry);
          if (time !== undefined) return time;
          carry = chunk.slice(0, firstNl);
        } else {
          // The whole window is one un-terminated record — accumulate it with
          // the carried tail so the record is reassembled in an older window.
          carry = chunk + carry;
        }
        offset = start;
      }
      // The oldest record reached the head of the file still split.
      return carry.length > 0 ? lastTurnBoundaryTimeInChunk(carry) : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
