import { describe, expect, it } from 'vitest';
import { parseTaskListResult, parseTaskOutputResult, parseTaskStopResult } from '../src/lib/parseTaskToolResult';

describe('parseTaskListResult', () => {
  it('parses task blocks separated by ---', () => {
    const r = parseTaskListResult([
      'active_background_tasks: 2\ntask_id: bash-1\nkind: process\ndescription: dev server\nstatus: running\ncommand: pnpm dev\n---\ntask_id: agent-2\nkind: agent\ndescription: explore\nstatus: running',
    ]);
    expect(r).toEqual({
      activeOnly: true,
      count: 2,
      tasks: [
        { task_id: 'bash-1', kind: 'process', description: 'dev server', status: 'running', command: 'pnpm dev' },
        { task_id: 'agent-2', kind: 'agent', description: 'explore', status: 'running' },
      ],
    });
  });

  it('handles an empty list', () => {
    expect(parseTaskListResult(['background_tasks: 0', 'No background tasks found.'])).toEqual({
      activeOnly: false,
      count: 0,
      tasks: [],
    });
  });

  it('rejects other output', () => {
    expect(parseTaskListResult(['Task not found: x'])).toBeNull();
  });
});

describe('parseTaskOutputResult', () => {
  it('splits fields from the output preview', () => {
    const r = parseTaskOutputResult([
      'retrieval_status: success\ntask_id: bash-1\nkind: process\ndescription: build\nstatus: completed\nexit_code: 0\n\n[output]\nline 1\nline 2\n',
    ]);
    expect(r?.fields).toMatchObject({ task_id: 'bash-1', status: 'completed', exit_code: '0' });
    expect(r?.output).toEqual(['line 1', 'line 2']);
    expect(r?.truncated).toBe(false);
  });

  it('marks truncation and empty previews', () => {
    const r = parseTaskOutputResult([
      'task_id: bash-1\nstatus: running\n\n[Truncated. Full output: /tmp/x.log]\n[output]\n[no output available]',
    ]);
    expect(r?.truncated).toBe(true);
    expect(r?.output).toEqual([]);
  });
});

describe('parseTaskStopResult', () => {
  it('reads the stop fields', () => {
    expect(parseTaskStopResult(['task_id: bash-1\nstatus: killed\nreason: no longer needed'])).toEqual({
      task_id: 'bash-1',
      status: 'killed',
      reason: 'no longer needed',
    });
  });

  it('rejects errors', () => {
    expect(parseTaskStopResult(['Failed to stop task: bash-1'])).toBeNull();
  });
});
