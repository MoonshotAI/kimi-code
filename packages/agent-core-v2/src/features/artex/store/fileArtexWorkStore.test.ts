import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderConstraintBlock } from '#/features/artex/prompts/index';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexInsertAssetsTool } from '#/features/artex/tools/insert_assets/insert_assets';

import { parseAssetDsl, validateAssetDsl } from './assetDsl';
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

  it('evaluates assetDsl boolean AST queries (AND, OR, NOT, parens, field predicates)', async () => {
    await runInsert(store, dir, [
      {
        type: 'service',
        url: 'https://api.example.com:8443/v1',
        status_code: 403,
        technologies: ['Nginx', 'Spring'],
        page_title: 'Admin API',
      },
      {
        type: 'service',
        url: 'http://blog.example.com/news',
        status_code: 200,
        technologies: ['WordPress'],
        page_title: 'Company Blog',
      },
      {
        type: 'service',
        url: 'https://legacy.example.com:8080/login',
        status_code: 500,
        technologies: ['Tomcat', 'Shiro'],
        page_title: 'Legacy Portal',
      },
    ]);

    const ast = parseAssetDsl('(port>=8080 OR technology=shiro) AND NOT status_code==200');
    expect(ast?.kind).toBe('and');
    expect(() => validateAssetDsl('(port=notanumber')).toThrow();
    expect(() => validateAssetDsl('port=abc')).toThrow(/integer/);

    const matched = await store.listAssets({
      taskId: 1,
      dsl: '(port>=8080 OR technology=shiro) AND NOT status_code==200',
    });
    expect(matched.map((a) => a.url)).toEqual([
      'https://api.example.com:8443/v1',
      'https://legacy.example.com:8080/login',
    ]);

    const exactAndExclude = await store.listAssets({
      taskId: 1,
      dsl: 'domain=example.com AND technology!=Shiro AND status_code<500',
    });
    expect(exactAndExclude.map((a) => a.url)).toEqual([
      'https://api.example.com:8443/v1',
      'http://blog.example.com/news',
    ]);
  });

  it('validates company scope prefixes/TLDs and re-attributes existing unowned assets', async () => {
    await runInsert(store, dir, [
      { type: 'subdomain', domain: 'app.acme.example.com' },
      { type: 'ip', ip: '198.51.100.42' },
    ]);
    const explicit = await store.upsertAsset({
      type: 'subdomain',
      domain: 'pinned.acme.example.com',
      companyId: 999,
    });

    const company = await store.upsertCompany('Acme Corp');
    const result = await store.addCompanyScope(
      company.id,
      ['acme.example.com', '198.51.100.0/24', '10.0.0.0/8', 'com', 'co.uk', '999.999.1.1'],
      'whois',
    );
    expect(result.added).toBe(2);
    expect(result.invalid).toBe(4);
    expect(result.errors.some((e) => e.includes('/16'))).toBe(true);
    expect(result.errors.some((e) => e.includes('bare TLD'))).toBe(true);

    const assets = await store.listAssets({ dsl: 'example.com OR 198.51.100.42' });
    const appAsset = assets.find((a) => a.domain === 'app.acme.example.com');
    const ipAsset = assets.find((a) => a.ip === '198.51.100.42');
    const pinnedAsset = await store.getAsset(explicit.id);
    expect(appAsset?.companyId).toBe(company.id);
    expect(ipAsset?.companyId).toBe(company.id);
    expect(pinnedAsset?.companyId).toBe(999);
  });

  it('preserves prior constraint IDs with appendConstraints and renders constraint blocks', async () => {
    const first = await store.appendConstraints(
      1,
      [{ kind: 'allow', text: 'test only port 443' }],
      'main',
    );
    const second = await store.appendConstraints(
      1,
      [{ kind: 'deny', text: 'do not run brute force' }],
      'main',
    );
    const all = await store.listConstraints(1);
    expect(all.map((c) => c.id)).toEqual([first[0]!.id, second[0]!.id]);

    const block = renderConstraintBlock(all);
    expect(block).toContain('Allowed operations:\n- test only port 443');
    expect(block).toContain('Forbidden operations:\n- do not run brute force');
  });

  it('enforces recordCoverage field caps and 2000-row limit while allowing updates', async () => {
    await expect(
      store.recordCoverage(1, {
        surface: 'x'.repeat(201),
        riskArea: 'sqli',
        outcome: 'no_issue_found',
        evidence: 'ok',
        reason: '',
      }),
    ).rejects.toThrow(/surface too long/);

    await expect(
      store.recordCoverage(1, {
        surface: '/login',
        riskArea: 'r'.repeat(65),
        outcome: 'no_issue_found',
        evidence: 'ok',
        reason: '',
      }),
    ).rejects.toThrow(/risk_area too long/);

    await expect(
      store.recordCoverage(1, {
        surface: '/login',
        riskArea: 'sqli',
        outcome: 'no_issue_found',
        evidence: 'e'.repeat(501),
        reason: '',
      }),
    ).rejects.toThrow(/evidence too long/);

    await expect(
      store.recordCoverage(1, {
        surface: '/login',
        riskArea: 'sqli',
        outcome: 'ruled_out',
        evidence: '',
        reason: 'r'.repeat(501),
      }),
    ).rejects.toThrow(/reason too long/);

    for (let i = 0; i < 2000; i += 1) {
      await store.recordCoverage(2, {
        surface: `/ep/${String(i)}`,
        riskArea: 'xss',
        outcome: 'no_issue_found',
        evidence: 'ok',
        reason: '',
        intentId: 10,
      });
    }
    await expect(
      store.recordCoverage(2, {
        surface: '/ep/2000',
        riskArea: 'xss',
        outcome: 'no_issue_found',
        evidence: 'ok',
        reason: '',
      }),
    ).rejects.toThrow(/max 2000/);

    await store.recordCoverage(2, {
      surface: '/ep/0',
      riskArea: 'xss',
      outcome: 'reported',
      evidence: 'updated',
      reason: '',
      intentId: 11,
    });
    const entries = await store.coverageEntries(2);
    expect(entries.find((e) => e.surface === '/ep/0')?.intentId).toBe(11);
  });

  it('handles 120 concurrent writers on FileArtexWorkStore without losing updates', async () => {
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        store.upsertAsset({ type: 'subdomain', domain: `w${String(i)}.concurrent.example.test` }, 1),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(120);
    expect(await store.assetsForTask(1)).toHaveLength(120);
  });
});
