import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WIRE_RENDERERS } from '../src/components/wire/renderers';

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
});
