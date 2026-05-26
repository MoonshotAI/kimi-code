import { describe, it, expect, afterEach } from 'vitest';
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
    expect(result.records[0]!._lineNo).toBe(2); // metadata is line 1, first record is line 2
    expect(result.records.at(-1)!._lineNo).toBe(11);
    expect(result.records.map((r) => r.type)).toEqual([
      'config.update',
      'tools.set_active_tools',
      'permission.set_mode',
      'turn.prompt',
      'context.append_message',
      'context.append_loop_event',
      'context.append_loop_event',
      'context.append_loop_event',
      'context.append_message',
      'usage.record',
    ]);
  });

  it('rejects unsupported protocol version', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const path = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const { writeFile, readFile } = await import('node:fs/promises');
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines[0] = '{"type":"metadata","protocol_version":"2.2","created_at":1}';
    await writeFile(path, lines.join('\n'));
    await expect(readAgentWire(path)).rejects.toThrow(/unsupported protocol/i);
  });

  it('collects warnings for malformed body lines', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const path = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, 'not json\n');
    const result = await readAgentWire(path);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/line 12/);
  });
});
