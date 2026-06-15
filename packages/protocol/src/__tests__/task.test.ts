import { describe, expect, it } from 'vitest';

import {
  backgroundTaskKindSchema,
  backgroundTaskSchema,
  backgroundTaskStatusSchema,
  type BackgroundTask,
} from '../task';

describe('backgroundTaskKindSchema', () => {
  it.each(['subagent', 'bash', 'tool'] as const)('accepts %s', (k) => {
    expect(backgroundTaskKindSchema.parse(k)).toBe(k);
  });

  it("rejects agent-core's 'process' / 'agent' / 'question' literals", () => {
    expect(backgroundTaskKindSchema.safeParse('process').success).toBe(false);
    expect(backgroundTaskKindSchema.safeParse('agent').success).toBe(false);
    expect(backgroundTaskKindSchema.safeParse('question').success).toBe(false);
  });
});

describe('backgroundTaskStatusSchema', () => {
  it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
    'accepts %s',
    (s) => {
      expect(backgroundTaskStatusSchema.parse(s)).toBe(s);
    },
  );

  it("rejects agent-core's 'timed_out' / 'killed' / 'lost' literals (adapter maps)", () => {
    expect(backgroundTaskStatusSchema.safeParse('timed_out').success).toBe(false);
    expect(backgroundTaskStatusSchema.safeParse('killed').success).toBe(false);
    expect(backgroundTaskStatusSchema.safeParse('lost').success).toBe(false);
  });
});

describe('backgroundTaskSchema', () => {
  const full: BackgroundTask = {
    id: 'task_01HXYZ',
    session_id: 'sess_01HZZZ',
    kind: 'bash',
    description: 'pnpm install',
    status: 'running',
    created_at: '2026-06-04T10:00:00.000Z',
    started_at: '2026-06-04T10:00:00.000Z',
  };

  it('round-trips a running task', () => {
    expect(backgroundTaskSchema.parse(full)).toEqual(full);
  });

  it('round-trips a completed task with completed_at + output fields', () => {
    const completed: BackgroundTask = {
      ...full,
      status: 'completed',
      completed_at: '2026-06-04T10:01:00.000Z',
      output_preview: 'first line\nsecond line',
      output_bytes: 4096,
    };
    expect(backgroundTaskSchema.parse(completed).output_bytes).toBe(4096);
  });

  it('rejects negative output_bytes', () => {
    const bad = { ...full, output_bytes: -1 };
    expect(backgroundTaskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed created_at (no timezone)', () => {
    const bad = { ...full, created_at: '2026-06-04T10:00:00' };
    expect(backgroundTaskSchema.safeParse(bad).success).toBe(false);
  });
});
