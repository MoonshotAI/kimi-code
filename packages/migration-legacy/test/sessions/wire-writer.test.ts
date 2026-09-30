import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMainAgentWire } from '../../src/sessions/wire-writer.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wire-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readWireRecords(): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const content = await readFile(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string });
}

describe('writeMainAgentWire', () => {
  it('writes a metadata header at line 0 with protocol_version=1.0', async () => {
    await writeMainAgentWire(dir, { createdAtMs: 1700000000000, messages: [] });
    const content = await readFile(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const firstLine = content.split('\n')[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed).toEqual({
      type: 'metadata',
      protocol_version: '1.0',
      created_at: 1700000000000,
    });
  });

  it('wraps each user turn in turn.prompt/turn.ended records', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
    });
    const records = await readWireRecords();
    expect(records.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
    ]);
    const prompt = records[1]!;
    expect(prompt['agentId']).toBe('main');
    expect(prompt['origin']).toEqual({ kind: 'user' });
    expect(prompt['input']).toEqual([{ type: 'text', text: 'hi' }]);
    expect(prompt['time']).toBe(1);
    const ended = records[4]!;
    expect(ended).toMatchObject({ agentId: 'main', turnId: 0, reason: 'completed' });
  });

  it('numbers one turn.prompt per user message with sequential turnIds', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'two' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }], toolCalls: [] },
      ],
    });
    const records = await readWireRecords();
    const prompts = records.filter((r) => r.type === 'turn.prompt');
    const endeds = records.filter((r) => r.type === 'turn.ended');
    expect(prompts).toHaveLength(2);
    expect(endeds.map((r) => r['turnId'])).toEqual([0, 1]);
  });

  it('opens a system_trigger turn for a leading non-user orphan run', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'orphan' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
    });
    const records = await readWireRecords();
    const prompts = records.filter((r) => r.type === 'turn.prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.['origin']).toEqual({ kind: 'system_trigger', name: 'imported_orphan' });
    expect(prompts[0]?.['input']).toEqual([]);
    expect(prompts[1]?.['origin']).toEqual({ kind: 'user' });
    expect(records.filter((r) => r.type === 'turn.ended').map((r) => r['turnId'])).toEqual([0, 1]);
  });

  it('omits turn.ended for a trailing unanswered user turn', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'anyone?' }], toolCalls: [] },
      ],
    });
    const records = await readWireRecords();
    expect(records.filter((r) => r.type === 'turn.prompt')).toHaveLength(2);
    expect(records.filter((r) => r.type === 'turn.ended').map((r) => r['turnId'])).toEqual([0]);
  });

  it('appends a token_counting.measured record when a legacy usage count exists', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      lastUsageTokenCount: 9133,
    });
    const records = await readWireRecords();
    const measured = records.at(-1)!;
    expect(measured).toMatchObject({
      type: 'token_counting.measured',
      agentId: 'main',
      length: 2,
      tokens: 9133,
    });
  });

  it('appends a tools.update_store record for the imported todo list', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      todoItems: [
        { title: 'task one', status: 'done' },
        { title: 'task two', status: 'pending' },
      ],
    });
    const records = await readWireRecords();
    expect(records.at(-1)).toMatchObject({
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [
        { title: 'task one', status: 'done' },
        { title: 'task two', status: 'pending' },
      ],
    });
  });

  it('omits the tools.update_store record when the todo list is empty', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      todoItems: [],
    });
    const records = await readWireRecords();
    expect(records.some((r) => r.type === 'tools.update_store')).toBe(false);
  });

  it('creates agents/main directory tree if missing', async () => {
    await writeMainAgentWire(dir, { createdAtMs: 1, messages: [] });
    const path = join(dir, 'agents', 'main', 'wire.jsonl');
    await expect(readFile(path, 'utf-8')).resolves.not.toThrow();
  });
});
