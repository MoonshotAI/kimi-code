import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WIRE_RENDERERS } from '../src/components/wire/renderers';

type CheckpointRecord = Parameters<
  (typeof WIRE_RENDERERS)['file_history.checkpoint']['headline']
>[0];
type TrackedRecord = Parameters<
  (typeof WIRE_RENDERERS)['file_history.tracked']['headline']
>[0];

function checkpointRecord(overrides: Record<string, unknown> = {}): CheckpointRecord {
  return {
    type: 'file_history.checkpoint',
    agentId: 'main',
    turnId: 7,
    phase: 'start',
    entries: {},
    ...overrides,
  } as unknown as CheckpointRecord;
}

function trackedRecord(overrides: Record<string, unknown> = {}): TrackedRecord {
  return {
    type: 'file_history.tracked',
    agentId: 'main',
    turnId: 7,
    path: '/workspace/example.txt',
    entry: { key: 'snapshot-7', version: 2 },
    ...overrides,
  } as unknown as TrackedRecord;
}

const HISTORICAL_OR_HEADER_TYPES = new Set([
  'metadata',
  'context.update_token_count',
  'micro_compaction.apply',
  'staleGuard.recorded',
  'staleGuard.cleared',
]);

describe('wire renderers', () => {
  it('covers every durable record in the current core-v2 wire manifest', async () => {
    const manifestPath = resolve(
      import.meta.dirname,
      '../../../../packages/agent-core-v2/docs/wire-manifest.d.ts',
    );
    const manifest = await readFile(manifestPath, 'utf8');
    const index = /\/\/ Index \(\d+ record types\)\n((?:\/\/   .*\n)+)/.exec(manifest)?.[1];
    expect(index).toBeDefined();

    const upstreamTypes = [...(index ?? '').matchAll(/^\/\/   (\S+)/gm)]
      .map((match) => match[1])
      .toSorted();
    const renderedCurrentTypes = Object.keys(WIRE_RENDERERS)
      .filter((type) => !HISTORICAL_OR_HEADER_TYPES.has(type))
      .toSorted();

    expect(renderedCurrentTypes).toEqual(upstreamTypes);
  });

  it('distinguishes oversized snapshots from files that did not exist', () => {
    const renderer = WIRE_RENDERERS['file_history.tracked'];
    const oversized = trackedRecord({
      entry: { key: null, version: 2, oversize: true, size: 10_000_000 },
    });
    const oversizedHeadline = renderer.headline(oversized);
    const oversizedDetail = renderer.detail?.(oversized);

    expect(renderToStaticMarkup(oversizedHeadline.right)).toContain('oversize');
    expect(renderToStaticMarkup(oversizedHeadline.right)).not.toContain('new');
    expect(renderToStaticMarkup(oversizedDetail)).toContain('not captured: oversized');
    expect(renderToStaticMarkup(oversizedDetail)).not.toContain('file did not exist');

    const missing = trackedRecord({ entry: { key: null, version: 2 } });
    const missingHeadline = renderer.headline(missing);
    const missingDetail = renderer.detail?.(missing);

    expect(renderToStaticMarkup(missingHeadline.right)).toContain('new');
    expect(renderToStaticMarkup(missingDetail)).toContain('file did not exist');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['scalar', 'broken'],
    ['array', []],
  ])('renders a checkpoint with %s entries without throwing', (_label, entries) => {
    const renderer = WIRE_RENDERERS['file_history.checkpoint'];
    const record = checkpointRecord({
      turnId: { unexpected: true },
      phase: { unexpected: true },
      entries,
    });
    const headline = renderer.headline(record);
    const detail = renderer.detail?.(record);

    expect(renderToStaticMarkup(headline.main)).toContain('entries unavailable');
    expect(renderToStaticMarkup(headline.main)).toContain('invalid');
    expect(renderToStaticMarkup(headline.right)).toContain('invalid');
    expect(() => renderToStaticMarkup(detail)).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['scalar', 'broken'],
    ['array', []],
  ])('renders a tracked record with a %s entry without throwing', (_label, entry) => {
    const renderer = WIRE_RENDERERS['file_history.tracked'];
    const record = trackedRecord({
      turnId: { unexpected: true },
      path: { unexpected: true },
      entry,
    });
    const headline = renderer.headline(record);
    const detail = renderer.detail?.(record);

    expect(renderToStaticMarkup(headline.main)).toContain('invalid');
    expect(renderToStaticMarkup(headline.right)).toContain('entry unavailable');
    expect(renderToStaticMarkup(detail)).toContain('entry unavailable');
  });

  it('renders malformed tracked fields as readable text', () => {
    const renderer = WIRE_RENDERERS['file_history.tracked'];
    const malformed = { unexpected: true };
    const record = trackedRecord({
      turnId: malformed,
      path: malformed,
      entry: {
        key: malformed,
        version: malformed,
        contentHash: malformed,
        size: malformed,
        mtimeMs: malformed,
        oversize: malformed,
      },
    });
    const headline = renderer.headline(record);
    const detail = renderer.detail?.(record);

    expect(renderToStaticMarkup(headline.main)).toContain('invalid');
    expect(renderToStaticMarkup(headline.right)).toContain('invalid entry');
    expect(renderToStaticMarkup(detail)).toContain('invalid');
    expect(renderToStaticMarkup(detail)).not.toContain('[object Object]');
  });
});
