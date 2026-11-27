import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { cronToolContexts } from '../src/chat/tool-calls/cronToolContext';

const turn = (tools: ToolCall[]): ChatTurn => ({ id: 'turn', role: 'assistant', no: 1, text: '', tools });
const create: ToolCall = { id: 'create', name: 'CronCreate', status: 'ok', arg: '{"prompt":"check status"}', output: ['id: job-1\ncron: */5 * * * *\nrecurring: true\nnextFireAt: 2026-09-21T13:00:00Z'] };
const remove: ToolCall = { id: 'delete', name: 'CronDelete', status: 'ok', arg: '{"id":"job-1"}', output: ['Deleted cron job job-1.'] };

describe('cronToolContexts', () => {
  it('preserves creation metadata on deletion without a future trigger', () => {
    expect(cronToolContexts([turn([create, remove])]).get('delete')).toEqual({ id: 'job-1', cron: '*/5 * * * *', recurring: 'true', prompt: 'check status', nextFireAt: undefined });
  });

  it('uses the latest preceding list metadata and decodes its prompt', () => {
    const list: ToolCall = { id: 'list', name: 'CronList', status: 'ok', arg: '{}', output: ['cron_jobs: 1\nid: job-1\ncron: 0 * * * *\nprompt: "updated\\nprompt"\nrecurring: false'] };
    const contexts = cronToolContexts([turn([create, list, remove])]);
    expect(contexts.get('delete')).toMatchObject({ cron: '0 * * * *', prompt: 'updated\nprompt', recurring: 'false' });
  });

  it('does not use later creations, failed calls, or another conversation', () => {
    expect(cronToolContexts([turn([remove, create])]).size).toBe(0);
    expect(cronToolContexts([turn([{ ...create, status: 'error' }, remove])]).size).toBe(0);
    cronToolContexts([turn([create])]);
    expect(cronToolContexts([turn([remove])]).size).toBe(0);
  });

  it('reads tools from ordered blocks and keeps deletion metadata immutable', () => {
    const item = { ...turn([]), blocks: [create, remove, { ...create, arg: '{"prompt":"later"}' }].map((tool) => ({ kind: 'tool' as const, tool })) };
    expect(cronToolContexts([item]).get('delete')?.prompt).toBe('check status');
  });
});
