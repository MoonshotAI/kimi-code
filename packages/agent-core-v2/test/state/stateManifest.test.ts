/**
 * Scenario: the checked-in state manifest matches the statically collected
 * `states.register(...)` call sites and parses as a valid TypeScript
 * declaration file.
 *
 * Rebuilds `docs/state-manifest.d.ts` from the `defineState` key constants and
 * their register call sites and fails when the file is stale. Regenerate with
 * `pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest`.
 */

import { readFileSync } from 'node:fs';

import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { buildStateManifest, MANIFEST_PATH } from '../../scripts/gen-state-manifest.mts';

describe('state manifest', () => {
  it('docs/state-manifest.d.ts is up to date', () => {
    const expected = buildStateManifest();
    const actual = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(actual).toBe(expected);
  }, 120_000);

  it('docs/state-manifest.d.ts parses as TypeScript', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'state-manifest.d.ts',
      readFileSync(MANIFEST_PATH, 'utf-8'),
    );
    const diagnostics = (sourceFile.compilerNode as { parseDiagnostics?: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics ?? []).toEqual([]);
  });
});
