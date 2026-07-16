import { describe, expect, it } from 'vitest';

import {
  taskKindSchema,
  taskSchema,
  taskStatusSchema,
  type Task,
} from '../task';

describe('taskKindSchema', () => {
  it.each(['subagent', 'bash', 'tool'] as const)('accepts %s', (k) => {
    expect(taskKindSchema.parse(k)).toBe(k);
  });

  it("rejects agent-core's 'process' / 'agent' / 'question' literals", () => {
    expect(taskKindSchema.safeParse('process').success).toBe(false);
    expect(taskKindSchema.safeParse('agent').success).toBe(false);
    expect(taskKindSchema.safeParse('question').success).toBe(false);
  });
});

describe('taskStatusSchema', () => {
  it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
    'accepts %s',
    (s) => {
      expect(taskStatusSchema.parse(s)).toBe(s);
    },
  );

  it("rejects agent-core's 'timed_out' / 'killed' / 'lost' literals (adapter maps)", () => {
    expect(taskStatusSchema.safeParse('timed_out').success).toBe(false);
    expect(taskStatusSchema.safeParse('killed').success).toBe(false);
    expect(taskStatusSchema.safeParse('lost').success).toBe(false);
  });
});

describe('taskSchema', () => {
  const full: Task = {
    id: 'task_01HXYZ',
    session_id: 'sess_01HZZZ',
    kind: 'bash',
    description: 'pnpm install',
    status: 'running',
    created_at: '2026-06-04T10:00:00.000Z',
    started_at: '2026-06-04T10:00:00.000Z',
  };

  it('round-trips a running task', () => {
    expect(taskSchema.parse(full)).toEqual(full);
  });

  it('round-trips a completed task with completed_at + output fields', () => {
    const completed: Task = {
      ...full,
      status: 'completed',
      completed_at: '2026-06-04T10:01:00.000Z',
      output_preview: 'first line\nsecond line',
      output_bytes: 4096,
    };
    expect(taskSchema.parse(completed).output_bytes).toBe(4096);
  });

  it('rejects negative output_bytes', () => {
    const bad = { ...full, output_bytes: -1 };
    expect(taskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed created_at (no timezone)', () => {
    const bad = { ...full, created_at: '2026-06-04T10:00:00' };
    expect(taskSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts the optional run_in_background flag', () => {
    expect(taskSchema.parse({ ...full, run_in_background: false }).run_in_background).toBe(false);
    expect(taskSchema.parse(full).run_in_background).toBeUndefined();
  });
});
