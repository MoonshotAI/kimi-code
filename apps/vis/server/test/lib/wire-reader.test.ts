import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionFixture } from '../fixtures/build';
import { readAgentWire } from '../../src/lib/wire-reader';

describe('wire-reader', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('reads main agent wire and assigns line numbers', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const result = await readAgentWire(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    expect(result.metadata.protocolVersion).toBe('1.1');
    expect(result.records[0]!.lineNo).toBe(2); // metadata is line 1, first record is line 2
    expect(result.records.at(-1)!.lineNo).toBe(10);
    expect(result.records.map((r) => r.data.type)).toEqual([
      'config.update',
      'tools.set_active_tools',
      'permission.set_mode',
      'turn.prompt',
      'context.append_message',
      'context.append_loop_event',
      'context.append_loop_event',
      'context.append_loop_event',
      'usage.record',
    ]);
    // No vis annotation should leak into the data/raw bodies.
    for (const entry of result.records) {
      expect(entry.data).not.toHaveProperty('_lineNo');
      expect(entry.raw as object).not.toHaveProperty('_lineNo');
    }
  });

  it('accepts v1.0 wire and migrates nested tool calls to flat shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vis-v10-'));
    const path = join(dir, 'wire.jsonl');
    const lines = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.0', created_at: 1 }),
      JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'calling' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_1',
              function: { name: 'Read', arguments: '{"path":"/x"}' },
            },
          ],
        },
      }),
    ];
    await writeFile(path, lines.join('\n') + '\n');
    try {
      const result = await readAgentWire(path);
      expect(result.metadata.protocolVersion).toBe('1.0');
      const entry = result.records[0]!;
      expect(entry.data.type).toBe('context.append_message');

      // `data` carries the migrated (flat) shape.
      const dataMsg = (entry.data as { message: { toolCalls: unknown[] } }).message;
      expect(dataMsg.toolCalls[0]).toEqual({
        type: 'function',
        id: 'call_1',
        name: 'Read',
        arguments: '{"path":"/x"}',
      });
      expect(dataMsg.toolCalls[0]).not.toHaveProperty('function');

      // `raw` keeps the on-disk (nested) shape — this is what the "as
      // written" view in the detail panel relies on.
      const rawMsg = (entry.raw as { message: { toolCalls: Array<{ function: unknown; name?: unknown }> } }).message;
      expect(rawMsg.toolCalls[0]).toHaveProperty('function');
      expect(rawMsg.toolCalls[0].function).toEqual({ name: 'Read', arguments: '{"path":"/x"}' });
      expect(rawMsg.toolCalls[0]).not.toHaveProperty('name');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('best-effort parses unknown protocol versions with a warning', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const path = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const { writeFile, readFile } = await import('node:fs/promises');
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines[0] = '{"type":"metadata","protocol_version":"2.2","created_at":1}';
    await writeFile(path, lines.join('\n'));
    const result = await readAgentWire(path);
    expect(result.metadata.protocolVersion).toBe('2.2');
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /unrecognised protocol_version.*2\.2/i.test(w))).toBe(
      true,
    );
  });

  it('collects warnings for malformed body lines', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const path = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, 'not json\n');
    const result = await readAgentWire(path);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/line 11/);
  });
});
