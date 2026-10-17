/**
 * Scenario: the interactive TUI detects when an external client has appended
 * turns to the session's wire journal so it can warn the user before their
 * next input silently forks the conversation.
 *
 * Responsibilities: `lastTurnBoundaryTimeInChunk` recovers the newest user-turn
 * (`turn.prompt`) timestamp from a wire-journal tail chunk,
 * `readWireTurnBoundaryTime` locates that boundary in the on-disk journal even
 * when it has been pushed past the tail read window, and
 * `wireTailAheadOfTranscript` decides staleness by comparing the boundary
 * against the newest turn the in-memory transcript has rendered.
 *
 * Wiring: pure helpers + a single file read only — no TUI or SDK imports, so
 * the check runs without any terminal, session, or engine dependency.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/wire-staleness.test.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  agentWirePath,
  lastTurnBoundaryTimeInChunk,
  readWireTurnBoundaryTime,
  wireTailAheadOfTranscript,
} from '@/tui/utils/wire-staleness';

describe('wireTailAheadOfTranscript', () => {
  it('detects a wire user-turn newer than the in-memory transcript tip', () => {
    expect(
      wireTailAheadOfTranscript({
        transcriptTipTime: 1_700_000_000_000,
        wireTailTime: 1_700_000_500_000,
      }),
    ).toBe(true);
  });

  it('is false when the wire user-turn matches the transcript tip', () => {
    expect(
      wireTailAheadOfTranscript({
        transcriptTipTime: 1_700_000_500_000,
        wireTailTime: 1_700_000_500_000,
      }),
    ).toBe(false);
  });

  it('is false when the wire user-turn predates the transcript tip', () => {
    expect(
      wireTailAheadOfTranscript({
        transcriptTipTime: 1_700_000_500_000,
        wireTailTime: 1_700_000_000_000,
      }),
    ).toBe(false);
  });

  it('fails open when either timestamp is unknown', () => {
    expect(
      wireTailAheadOfTranscript({ transcriptTipTime: undefined, wireTailTime: 1_700_000_500_000 }),
    ).toBe(false);
    expect(
      wireTailAheadOfTranscript({ transcriptTipTime: 1_700_000_000_000, wireTailTime: undefined }),
    ).toBe(false);
    expect(
      wireTailAheadOfTranscript({ transcriptTipTime: undefined, wireTailTime: undefined }),
    ).toBe(false);
  });
});

describe('lastTurnBoundaryTimeInChunk', () => {
  it('returns the newest `turn.prompt` time, skipping non-boundary records', () => {
    const chunk = [
      '{"type":"turn.prompt","time":100,"input":{"input":[],"origin":{}}}',
      '{"type":"turn.ended","time":200,"turnId":1,"reason":"completed"}',
      '{"type":"context.append_loop_event","time":300,"event":{"type":"content.part","part":{"type":"text","text":"hi"}}}',
      '{"type":"usage.record","time":400,"usage":{}}',
    ].join('\n');
    expect(lastTurnBoundaryTimeInChunk(chunk)).toBe(100);
  });

  it('returns the last of several `turn.prompt` records', () => {
    const chunk = [
      '{"type":"turn.prompt","time":100,"input":{}}',
      '{"type":"turn.ended","time":150,"turnId":1,"reason":"completed"}',
      '{"type":"turn.prompt","time":200,"input":{}}',
      '{"type":"turn.ended","time":250,"turnId":2,"reason":"completed"}',
    ].join('\n');
    expect(lastTurnBoundaryTimeInChunk(chunk)).toBe(200);
  });

  it('returns undefined when the chunk holds no user-turn record', () => {
    expect(
      lastTurnBoundaryTimeInChunk(
        '{"type":"metadata","protocol_version":"1","created_at":10}\n{"type":"usage.record","time":20,"usage":{}}\n',
      ),
    ).toBeUndefined();
    expect(lastTurnBoundaryTimeInChunk('')).toBeUndefined();
  });

  it('scans past a partial line fragment from the read-tail boundary', () => {
    // The read boundary split a long record; the fragment fails to parse and
    // the scan keeps going until it finds the complete `turn.prompt`.
    const chunk =
      '{"type":"context.append_loop_event","time":1,"event":{"type":"content.part","part":{"type":"text","text":"' +
      '\n{"type":"turn.prompt","time":300,"input":{}}';
    expect(lastTurnBoundaryTimeInChunk(chunk)).toBe(300);
  });

  it('ignores empty trailing lines and returns the newest complete record', () => {
    const chunk = '{"type":"turn.prompt","time":100,"input":{}}\n\n';
    expect(lastTurnBoundaryTimeInChunk(chunk)).toBe(100);
  });
});

describe('readWireTurnBoundaryTime', () => {
  /** Writes a journal and runs the assertion against it, cleaning up after. */
  async function withJournal(
    lines: string[],
    run: (dir: string, agentId: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'wire-staleness-'));
    try {
      const agentId = 'agent-1';
      await mkdir(join(dir, 'agents', agentId), { recursive: true });
      await writeFile(agentWirePath(dir, agentId), lines.join('\n'));
      await run(dir, agentId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads the newest `turn.prompt` from a small journal', async () => {
    await withJournal(
      [
        '{"type":"metadata","protocol_version":"1","created_at":10}',
        '{"type":"turn.prompt","time":100,"input":{}}',
        '{"type":"turn.ended","time":200,"turnId":1,"reason":"completed"}',
        '{"type":"turn.prompt","time":300,"input":{}}',
        '{"type":"usage.record","time":400,"usage":{}}',
      ],
      async (dir, agentId) => {
        await expect(readWireTurnBoundaryTime(dir, agentId)).resolves.toBe(300);
      },
    );
  });

  it('recovers a `turn.prompt` pushed past the 64 KiB tail window by a large post-prompt record', async () => {
    await withJournal(
      [
        '{"type":"metadata","protocol_version":"1","created_at":10}',
        '{"type":"turn.prompt","time":100,"input":{}}',
        // A single tool-output record larger than the 64 KiB tail read window
        // sits between the prompt and the journal tail. A single tail read
        // would only see the end of this record plus the newer records, miss
        // the prompt boundary, and fail open — the exact silent-fork path this
        // guard exists to catch.
        `{"type":"context.append_loop_event","time":200,"event":{"type":"content.part","part":{"type":"text","text":"${'x'.repeat(80 * 1024)}"}}}`,
        '{"type":"usage.record","time":300,"usage":{}}',
      ],
      async (dir, agentId) => {
        await expect(readWireTurnBoundaryTime(dir, agentId)).resolves.toBe(100);
      },
    );
  });

  it('recovers a `turn.prompt` when a record spanning several windows sits after it', async () => {
    await withJournal(
      [
        '{"type":"turn.prompt","time":50,"input":{}}',
        `{"type":"context.append_loop_event","time":60,"event":{"type":"content.part","part":{"type":"text","text":"${'y'.repeat(200 * 1024)}"}}}`,
        '{"type":"usage.record","time":70,"usage":{}}',
      ],
      async (dir, agentId) => {
        await expect(readWireTurnBoundaryTime(dir, agentId)).resolves.toBe(50);
      },
    );
  });

  it('fails open (undefined) when the journal holds no user-turn record', async () => {
    await withJournal(
      [
        '{"type":"metadata","protocol_version":"1","created_at":10}',
        `{"type":"context.append_loop_event","time":20,"event":{"type":"content.part","part":{"type":"text","text":"${'z'.repeat(80 * 1024)}"}}}`,
        '{"type":"usage.record","time":30,"usage":{}}',
      ],
      async (dir, agentId) => {
        await expect(readWireTurnBoundaryTime(dir, agentId)).resolves.toBeUndefined();
      },
    );
  });

  it('fails open (undefined) for an empty journal, missing session, or missing agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wire-staleness-'));
    try {
      const agentId = 'agent-1';
      await mkdir(join(dir, 'agents', agentId), { recursive: true });
      await writeFile(agentWirePath(dir, agentId), '');
      await expect(readWireTurnBoundaryTime(dir, agentId)).resolves.toBeUndefined();
      await expect(readWireTurnBoundaryTime('/nonexistent-session', agentId)).resolves.toBeUndefined();
      await expect(readWireTurnBoundaryTime(dir, 'no-such-agent')).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
