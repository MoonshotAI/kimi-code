import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexInsertAssetsTool } from '#/features/artex/tools/insert_assets/insert_assets';

import type { IArtexWorkStoreProvider } from './artexWorkStoreProvider';
import { FileArtexWorkStore } from './fileArtexWorkStore';

interface InsertOutput {
  readonly results: readonly { index: number; id: number; type: string }[];
  readonly errors: readonly { index: number; error: string }[];
}

async function runInsert(
  store: FileArtexWorkStore,
  dir: string,
  assets: readonly Record<string, unknown>[],
): Promise<InsertOutput> {
  const session: IArtexSessionContext = {
    _serviceBrand: undefined,
    workspaceRoot: dir,
    getActiveExplorationId: () => 1,
    setActiveExplorationId: () => undefined,
  };
  const provider: IArtexWorkStoreProvider = {
    _serviceBrand: undefined,
    open: () => store,
  };
  const tool = new ArtexInsertAssetsTool(session, provider);
  const execution = tool.resolveExecution({ assets: assets as never });
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  const result = await execution.execute({} as never);
  return JSON.parse(result.output as string) as InsertOutput;
}

describe('FileArtexWorkStore + insert_assets', () => {
  let dir: string;
  let store: FileArtexWorkStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-work-'));
    store = new FileArtexWorkStore(dir);
    await store.ensureSeeded();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dedups a repeated asset, auto-scopes it, and gates blacklisted assets', async () => {
    const out = await runInsert(store, dir, [
      { type: 'root_domain', domain: 'example.org' },
      { type: 'root_domain', domain: 'example.org' },
      { type: 'root_domain', domain: 'agency.gov' },
    ]);

    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.id).toBe(out.results[1]!.id);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.index).toBe(2);
    expect(out.errors[0]!.error).toContain('insertion forbidden');

    const stored = await store.listAssets({ text: 'example.org', taskId: 1 });
    expect(stored).toHaveLength(1);

    const scope = await store.listTaskScope(1);
    expect(scope.some((entry) => entry.source === 'auto')).toBe(true);
  });

  it('counts coverage denominator only under a declared scope root', async () => {
    await runInsert(store, dir, [{ type: 'subdomain', domain: 'a.ok.example.com' }]);

    const beforeRoot = await store.coverageDenominator(1);
    expect(beforeRoot.denominator).toBe(0);

    await store.addTaskScope(1, 'root_domain', 'ok.example.com', 'declared root', 'agent');

    const afterRoot = await store.coverageDenominator(1);
    expect(afterRoot.denominator).toBe(1);
    expect(afterRoot.assetIds).toHaveLength(1);
  });

  it('records coverage and lists untested assets against the denominator', async () => {
    await runInsert(store, dir, [
      { type: 'subdomain', domain: 'a.ok.example.com' },
      { type: 'subdomain', domain: 'b.ok.example.com' },
    ]);
    await store.addTaskScope(1, 'root_domain', 'ok.example.com', 'declared root', 'agent');

    const denom = await store.coverageDenominator(1);
    expect(denom.denominator).toBe(2);

    await store.recordCoverage(1, {
      surface: 'https://a.ok.example.com/login',
      riskArea: 'sqli',
      outcome: 'no_issue_found',
      evidence: 'fact-1',
      reason: '',
    });
    expect(await store.coverageEntryCount(1)).toBe(1);
    const entries = await store.coverageEntries(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.riskArea).toBe('sqli');

    const untested = await store.listUntestedAssets(1, [denom.assetIds[0]!]);
    expect(untested.total).toBe(1);
  });
});
