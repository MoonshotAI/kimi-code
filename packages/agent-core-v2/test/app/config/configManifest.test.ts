import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildConfigManifest, MANIFEST_PATH } from '../../../scripts/gen-config-manifest.mts';

describe('config manifest', () => {
  it('docs/config-manifest.toml is up to date', async () => {
    const expected = await buildConfigManifest();
    const actual = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(actual).toBe(expected);
  }, 60_000);
});
