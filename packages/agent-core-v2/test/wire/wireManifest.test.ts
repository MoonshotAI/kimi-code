/**
 * Scenario: the checked-in wire-protocol manifest matches the live OP_REGISTRY
 * and parses as a valid TypeScript declaration file.
 *
 * Rebuilds `docs/wire-manifest.d.ts` from the actual `defineOp` registrations
 * and fails when the file is stale. Regenerate with
 * `pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest`.
 */

import { readFileSync } from 'node:fs';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { buildWireManifest, MANIFEST_PATH } from '../../scripts/gen-wire-manifest.mts';

describe('wire manifest', () => {
  it('docs/wire-manifest.d.ts is up to date', async () => {
    const expected = await buildWireManifest();
    const actual = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(actual).toBe(expected);
  }, 60_000);

  it('docs/wire-manifest.d.ts parses as TypeScript', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'wire-manifest.d.ts',
      readFileSync(MANIFEST_PATH, 'utf-8'),
    );
    // `parseDiagnostics` is internal in the compiler typings but populated at runtime.
    const diagnostics = (sourceFile.compilerNode as { parseDiagnostics?: readonly unknown[] })
      .parseDiagnostics;
    expect(diagnostics ?? []).toEqual([]);
  });
});
