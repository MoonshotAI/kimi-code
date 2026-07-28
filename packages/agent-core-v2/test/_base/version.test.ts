import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getCoreVersion } from '#/_base/version';

const packageVersion = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
  ) as { version: string }
).version;

describe('version', () => {
  it('exposes a non-empty version string', () => {
    expect(typeof getCoreVersion()).toBe('string');
    expect(getCoreVersion().length).toBeGreaterThan(0);
  });

  it('resolves the agent-core-v2 package version in a source layout', () => {
    // Guards the package.json walk the bundled hosts replace with a define.
    expect(getCoreVersion()).toBe(packageVersion);
  });
});
