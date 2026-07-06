import { describe, expect, it } from 'vitest';

import { migrateV1_4ToV1_5 } from '../../../../src/agent/records/migration/v1.5';
import type { WireMigrationRecord } from '../../../../src/agent/records/migration';

function toolResultRecord(result: Record<string, unknown>): WireMigrationRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      parentUuid: 'c1',
      toolCallId: 'c1',
      result,
    },
    time: 42,
  };
}

function migratedResult(record: WireMigrationRecord): Record<string, unknown> {
  const migrated = migrateV1_4ToV1_5.migrateRecord(record) as unknown as {
    event: { result: unknown };
  };
  return migrated.event.result as Record<string, unknown>;
}

describe('1.4 to 1.5', () => {
  it('moves a leading ReadMediaFile <system> summary part into note', () => {
    const summary =
      '<system>Read image file. Mime type: image/png. Size: 70 bytes. ' +
      'Original dimensions: 4x2 pixels. Shown at native resolution; no downscaling applied. ' +
      'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.</system>';
    const result = migratedResult(
      toolResultRecord({
        output: [
          { type: 'text', text: summary },
          { type: 'text', text: '<image path="/tmp/a.png">' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,A' } },
          { type: 'text', text: '</image>' },
        ],
      }),
    );
    expect(result['note']).toBe(summary);
    expect(result['output']).toEqual([
      { type: 'text', text: '<image path="/tmp/a.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,A' } },
      { type: 'text', text: '</image>' },
    ]);
  });

  it('moves a trailing Read status block into note', () => {
    const status =
      '<system>2 lines read from file starting from line 1. ' +
      'Total lines in file: 2. End of file reached.</system>';
    const result = migratedResult(toolResultRecord({ output: `1\talpha\n2\tbeta\n${status}` }));
    expect(result['note']).toBe(status);
    expect(result['output']).toBe('1\talpha\n2\tbeta');
  });

  it('moves a bare Read status block (empty read) into note, leaving empty output', () => {
    const status =
      '<system>No lines read from file. Total lines in file: 0. End of file reached.</system>';
    const result = migratedResult(toolResultRecord({ output: status }));
    expect(result['note']).toBe(status);
    expect(result['output']).toBe('');
  });

  it('moves MCP image-compression captions into note, joining multiple with newlines', () => {
    const caption1 =
      '<system>Image compressed to fit model limits: original 2600x2600 image/png (2.0 MB) -> ' +
      'sent 2000x2000 image/jpeg (400 KB). Fine detail may be lost. ' +
      'The uncompressed original was not preserved.</system>';
    const caption2 =
      '<system>Image compressed to fit model limits: original 3000x1000 image/png (1.0 MB) -> ' +
      'sent 2000x667 image/jpeg (300 KB). Fine detail may be lost. ' +
      'The uncompressed original was not preserved.</system>';
    const result = migratedResult(
      toolResultRecord({
        output: [
          { type: 'text', text: 'page text' },
          { type: 'text', text: caption1 },
          { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,A' } },
          { type: 'text', text: caption2 },
          { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,B' } },
        ],
        isError: false,
      }),
    );
    expect(result['note']).toBe(`${caption1}\n${caption2}`);
    expect(result['output']).toEqual([
      { type: 'text', text: 'page text' },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,A' } },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,B' } },
    ]);
  });

  it('leaves unrecognized <system> text untouched (user data, not tool metadata)', () => {
    const record = toolResultRecord({
      output: 'cat result:\n<system>literal text from a user file</system>',
      isError: false,
    });
    expect(migrateV1_4ToV1_5.migrateRecord(record)).toBe(record);
  });

  it('leaves results that already carry a note untouched', () => {
    const record = toolResultRecord({
      output: '<system>Read image file. Mime type: image/png. Size: 1 bytes.</system>',
      note: '<system>already migrated</system>',
    });
    expect(migrateV1_4ToV1_5.migrateRecord(record)).toBe(record);
  });

  it('passes non-tool-result records through unchanged', () => {
    const record: WireMigrationRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: '<system>Read image file. Mime type: x.</system>' }],
      origin: { kind: 'user' },
    };
    expect(migrateV1_4ToV1_5.migrateRecord(record)).toBe(record);
  });

  it('preserves sibling result fields when migrating', () => {
    const status =
      '<system>1 line read from file starting from line 1. Total lines in file: 1.</system>';
    const result = migratedResult(
      toolResultRecord({ output: `1\ta\n${status}`, isError: false, truncated: true }),
    );
    expect(result['isError']).toBe(false);
    expect(result['truncated']).toBe(true);
    expect(result['note']).toBe(status);
  });
});
