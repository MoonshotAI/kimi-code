import { describe, expect, it } from 'vitest';

import {
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
  taskAlreadyFinishedDataSchema,
} from '../rest/task';

describe('listTasksQuerySchema', () => {
  it('accepts empty query', () => {
    expect(listTasksQuerySchema.parse({})).toEqual({});
  });
  it('accepts status filter', () => {
    expect(listTasksQuerySchema.parse({ status: 'running' })).toEqual({
      status: 'running',
    });
  });
  it('rejects unknown status', () => {
    expect(listTasksQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});

describe('listTasksResponseSchema', () => {
  it('round-trips empty items[]', () => {
    expect(listTasksResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });
});

describe('getTaskQuerySchema', () => {
  it('accepts empty query', () => {
    expect(getTaskQuerySchema.parse({})).toEqual({});
  });
  it('coerces with_output + output_bytes from strings (HTTP query)', () => {
    const parsed = getTaskQuerySchema.parse({ with_output: 'true', output_bytes: '512' });
    expect(parsed.with_output).toBe(true);
    expect(parsed.output_bytes).toBe(512);
  });
});

describe('getTaskResponseSchema', () => {
  it('parses a minimal task shape', () => {
    const t = {
      id: 'task_01',
      session_id: 'sess_01',
      kind: 'subagent' as const,
      description: 'spin up x',
      status: 'running' as const,
      created_at: '2026-06-04T10:00:00.000Z',
    };
    expect(getTaskResponseSchema.parse(t).kind).toBe('subagent');
  });
});

describe('cancelTaskResultSchema', () => {
  it('requires cancelled: true literal', () => {
    expect(cancelTaskResultSchema.parse({ cancelled: true })).toEqual({ cancelled: true });
    expect(cancelTaskResultSchema.safeParse({ cancelled: false }).success).toBe(false);
  });
});

describe('taskAlreadyFinishedDataSchema (40904 envelope data)', () => {
  it('requires cancelled: false literal', () => {
    expect(taskAlreadyFinishedDataSchema.parse({ cancelled: false })).toEqual({
      cancelled: false,
    });
    expect(taskAlreadyFinishedDataSchema.safeParse({ cancelled: true }).success).toBe(
      false,
    );
  });
});
