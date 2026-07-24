/**
 * Stress check for the kosong ⇄ kosongConfig read/write path, against an
 * in-process engine (memory transport) bootstrapped on a throwaway home.
 *
 * The contract under pressure: an awaited kosong mutation resolves only after
 * the write has been persisted by the kosongConfig bridge (with retries on
 * transient disk failures), and config-originated writes land in the kosong
 * registries synchronously. Every phase asserts read-after-write visibility
 * through BOTH facades — `kosong.*` (registry view) and `config.get` (the
 * persisted section the bridge writes) — with no sleeps or flush helpers:
 * any settling gap shows up here as a failed assertion.
 *
 * Phases:
 *   1. sequential provider add/remove read-after-write;
 *   2. same-name add/remove flip-flop (hammering the persist chain with
 *      alternating real writes and no-op merges);
 *   3. sequential default-model churn;
 *   4. concurrent burst adds (persist-chain serialization + merge);
 *   5. concurrent mixed sections: removes racing adds racing a default flip;
 *   6. config → kosong direction (config.replace must be visible to the
 *      registry facade immediately);
 *   7. restart durability: dispose the app, re-bootstrap on the same home,
 *      and compare every section against the pre-restart snapshot.
 *
 *   pnpm -C packages/klient stress:kosong-config
 *
 * Env: KIMI_MODEL_NAME is unset for the run (it would pin `defaultModel` and
 * break the pointer assertions); restored on exit.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IKosongConfigService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/kosongConfig';
import { type Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

interface ProvidersSectionView {
  readonly [name: string]: { readonly apiKey?: string } | undefined;
}

interface ModelsSectionView {
  readonly [id: string]: { readonly provider?: string; readonly model?: string } | undefined;
}

const apiKeyProvider = (apiKey: string) => ({
  type: 'openai',
  auth: { method: 'api-key' as const, apiKey },
});

const anonymousModel = (id: string) => ({
  id,
  model: `${id}-model`,
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:1',
  auth: { method: 'api-key' as const, apiKey: `sk-${id}` },
  maxContextSize: 8192,
});

/** Key-order-independent deep equality (post-restart TOML round-trips reorder keys). */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

async function phase(label: string, ops: number, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  await run();
  const elapsed = Date.now() - startedAt;
  console.log(
    `[ok] ${label}  ${String(ops)} ops in ${String(elapsed)}ms (${((ops * 1000) / Math.max(elapsed, 1)).toFixed(0)} ops/s)`,
  );
}

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-kosong-stress-'));
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  // Filled in right before the restart phase.
  let snapshot: Record<string, unknown> = {};
  try {
    const klient = createKlient({ scope: app });
    const config = klient.global.config;
    const kosong = klient.global.kosong;

    // 1) Sequential read-after-write: each awaited add must already be in the
    //    persisted section when it resolves — no settling window allowed.
    await phase('sequential provider add read-after-write', 30, async () => {
      for (let i = 0; i < 30; i += 1) {
        const name = `seq_${String(i)}`;
        await kosong.addProvider(name, apiKeyProvider(`sk-seq-${String(i)}`));
        const providers = await config.get<ProvidersSectionView>('providers');
        assert(
          providers[name]?.apiKey === `sk-seq-${String(i)}`,
          `providers.${name} persisted before addProvider resolved`,
        );
        const got = await kosong.getProvider(name);
        assert(got !== undefined, `providers.${name} visible to the registry facade`);
      }
    });

    // 2) Same-name flip-flop: add → remove → add on one key, asserting both
    //    directions of the write land before the await returns.
    await phase('same-name add/remove flip-flop', 30, async () => {
      for (let i = 0; i < 15; i += 1) {
        await kosong.addProvider('flip', apiKeyProvider(`sk-flip-${String(i)}`));
        let providers = await config.get<ProvidersSectionView>('providers');
        assert(providers['flip']?.apiKey === `sk-flip-${String(i)}`, 'flip add persisted');
        await kosong.removeProvider('flip');
        providers = await config.get<ProvidersSectionView>('providers');
        assert(providers['flip'] === undefined, 'flip remove persisted');
      }
    });

    // 3) Sequential default-model churn: every awaited pointer write must be
    //    visible in the persisted defaultModel section immediately.
    await phase('default-model churn', 22, async () => {
      await kosong.addProvider(anonymousModel('churn_a'));
      await kosong.addProvider(anonymousModel('churn_b'));
      for (let i = 0; i < 20; i += 1) {
        const id = i % 2 === 0 ? 'churn_a' : 'churn_b';
        await kosong.setDefaultModel(id);
        const def = await config.get<string>('defaultModel');
        assert(def === id, `defaultModel=${id} persisted before setDefaultModel resolved`);
      }
    });

    // 4) Concurrent burst: 40 adds racing on one section. The persist chain
    //    must serialize them and converge to the full set — no lost updates.
    await phase('concurrent burst adds', 40, async () => {
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          kosong.addProvider(`burst_${String(i)}`, apiKeyProvider(`sk-burst-${String(i)}`)),
        ),
      );
      const providers = await config.get<ProvidersSectionView>('providers');
      for (let i = 0; i < 40; i += 1) {
        assert(
          providers[`burst_${String(i)}`]?.apiKey === `sk-burst-${String(i)}`,
          `burst_${String(i)} survived the concurrent burst`,
        );
      }
    });

    // 5) Mixed sections racing: removes of phase-1 providers + anonymous-model
    //    adds (models section) + a default flip, all in flight at once.
    await phase('concurrent mixed sections', 41, async () => {
      await Promise.all([
        ...Array.from({ length: 30 }, (_, i) => kosong.removeProvider(`seq_${String(i)}`)),
        ...Array.from({ length: 10 }, (_, i) => kosong.addProvider(anonymousModel(`mix_${String(i)}`))),
        kosong.setDefaultModel('churn_b'),
      ]);
      const providers = await config.get<ProvidersSectionView>('providers');
      const models = await config.get<ModelsSectionView>('models');
      for (let i = 0; i < 30; i += 1) {
        assert(providers[`seq_${String(i)}`] === undefined, `seq_${String(i)} removal persisted`);
      }
      for (let i = 0; i < 10; i += 1) {
        assert(models[`mix_${String(i)}`]?.model === `mix_${String(i)}-model`, `mix_${String(i)} persisted`);
      }
      assert((await config.get<string>('defaultModel')) === 'churn_b', 'default flip persisted');
    });

    // 6) config → kosong: a config-originated write must be visible to the
    //    registry facade as soon as its await resolves.
    await phase('config-originated replace visible to registry', 4, async () => {
      await config.replace({
        domain: 'providers',
        value: {
          ...(await config.get<ProvidersSectionView>('providers')),
          cfg_only: { type: 'openai', apiKey: 'sk-cfg-only' },
        },
      });
      const got = await kosong.getProvider('cfg_only');
      assert(got !== undefined, 'config.replace(providers) visible to kosong.getProvider');

      await config.replace({
        domain: 'models',
        value: {
          ...(await config.get<ModelsSectionView>('models')),
          cfg_model: { provider: 'cfg_only', model: 'cfg-model', maxContextSize: 4096 },
        },
      });
      const modelIds = (await kosong.listModels()).map((m) => m.model);
      assert(modelIds.includes('cfg_model'), 'config.replace(models) visible to kosong.listModels');

      await config.set({ domain: 'providers', patch: { cfg_only: { apiKey: 'sk-cfg-updated' } } });
      const providers = await config.get<ProvidersSectionView>('providers');
      assert(providers['cfg_only']?.apiKey === 'sk-cfg-updated', 'config.set merge persisted');

      await kosong.removeProvider('cfg_only');
      assert(
        (await config.get<ProvidersSectionView>('providers'))['cfg_only'] === undefined,
        'registry remove persisted over the config-originated entry',
      );
    });

    snapshot = {
      providers: await config.get('providers'),
      models: await config.get('models'),
      defaultProvider: await config.get('defaultProvider'),
      defaultModel: await config.get('defaultModel'),
    };

    await klient.close();
  } finally {
    app.dispose();
  }

  // 7) Restart durability: a fresh engine on the SAME home must rehydrate the
  //    exact pre-restart state — the ultimate proof the writes hit the disk.
  await phase('restart durability', 1, async () => {
    const { app: app2 } = bootstrap({ homeDir }, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
    ]);
    try {
      // Reads race the async startup otherwise: config loads from disk, then
      // the bridge hydrates the registries from it.
      await app2.accessor.get(IConfigService).ready;
      await app2.accessor.get(IKosongConfigService).ready;
      const klient2: Klient = createKlient({ scope: app2 });
      for (const [section, expected] of Object.entries(snapshot)) {
        const actual: unknown = await klient2.global.config.get(section);
        if (stable(actual) !== stable(expected)) {
          console.error(`[diff] ${section}\n  expected: ${stable(expected)}\n  actual:   ${stable(actual)}`);
        }
        assert(
          stable(actual) === stable(expected),
          `${section} rehydrated from disk equal to the pre-restart snapshot`,
        );
      }
      const providerIds = new Set((await klient2.global.kosong.listProviders()).map((p) => p.id));
      for (const name of Object.keys(snapshot['providers'] as Record<string, unknown>)) {
        assert(providerIds.has(name), `provider ${name} listed after restart`);
      }
      await klient2.close();
    } finally {
      app2.dispose();
    }
  });

  await rm(homeDir, { recursive: true, force: true });
  console.log('kosong-config stress: OK');
}

const pinnedModelEnv = process.env['KIMI_MODEL_NAME'];
delete process.env['KIMI_MODEL_NAME'];
try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  if (pinnedModelEnv !== undefined) process.env['KIMI_MODEL_NAME'] = pinnedModelEnv;
}
