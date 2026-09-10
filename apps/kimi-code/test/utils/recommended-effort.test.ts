import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiConfig, KimiConfigPatch, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { applyRecommendedEffort } from '#/utils/recommended-effort';
import type { RecommendedEffortConfig } from '#/utils/recommended-effort-config';

const OFFICIAL_COM = 'https://api.kimi.com/coding/v1';
const OFFICIAL_AI = 'https://api.kimi.ai/coding/v1';
const GATEWAY = 'https://gateway.example.com/coding/v1';

const NOW = new Date('2026-09-05T02:00:00.000Z');
const CAMPAIGN = { version: 5, recommended_default_effort: 'max' };

function makeModelEntry(overrides: Partial<ModelAlias> = {}): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: 'k3',
    maxContextSize: 256000,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<KimiConfig> = {}): KimiConfig {
  return {
    providers: {
      'managed:kimi-code': { type: 'kimi', baseUrl: OFFICIAL_COM },
    },
    defaultModel: 'main',
    models: { main: makeModelEntry() },
    thinking: { effort: 'high' },
    ...overrides,
  };
}

function makeHarness(
  config: KimiConfig,
  cloud: RecommendedEffortConfig | undefined,
  stateFile: string,
) {
  const setConfig = vi.fn(async (_patch: KimiConfigPatch) => ({}) as KimiConfig);
  const track = vi.fn();
  const fetchConfig = vi.fn(async () => cloud);
  const getConfig = vi.fn(async () => config);
  const run = () =>
    applyRecommendedEffort({
      fetchConfig,
      getConfig,
      setConfig,
      track,
      stateFile,
      now: () => NOW,
    });
  return { setConfig, track, fetchConfig, getConfig, run };
}

async function readStateRaw(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf-8')) as unknown;
}

async function expectNoStateFile(file: string): Promise<void> {
  await expect(readFile(file, 'utf-8')).rejects.toThrow();
}

describe('applyRecommendedEffort', () => {
  let dir: string;
  let stateFile: string;
  const savedBaseUrl = process.env['KIMI_CODE_BASE_URL'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-recommended-effort-'));
    stateFile = join(dir, 'recommended-effort-state.json');
    delete process.env['KIMI_CODE_BASE_URL'];
  });

  afterEach(async () => {
    if (savedBaseUrl === undefined) {
      delete process.env['KIMI_CODE_BASE_URL'];
    } else {
      process.env['KIMI_CODE_BASE_URL'] = savedBaseUrl;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the recommended effort, records the marker, and reports the event', async () => {
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).toHaveBeenCalledTimes(1);
    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 5, applied_at: NOW.toISOString() },
    });
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('recommended_effort_applied', {
      model: 'k3',
      version: 5,
      effort: 'max',
      previous_effort: 'high',
    });
  });

  it('reports undefined previous_effort when thinking was never configured', async () => {
    const h = makeHarness(makeConfig({ thinking: undefined }), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
    expect(h.track).toHaveBeenCalledWith('recommended_effort_applied', {
      model: 'k3',
      version: 5,
      effort: 'max',
      previous_effort: undefined,
    });
  });

  it('does not add an enabled key when thinking.enabled is absent or explicit true', async () => {
    for (const thinking of [{ enabled: true }, { effort: 'low' }]) {
      const h = makeHarness(makeConfig({ thinking }), { k3: CAMPAIGN }, stateFile);

      await h.run();

      expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
      await rm(stateFile, { force: true });
    }
  });

  it('records only the marker when the current effort already equals the recommendation', async () => {
    const h = makeHarness(makeConfig({ thinking: { effort: 'max' } }), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).not.toHaveBeenCalled();
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 5, applied_at: NOW.toISOString() },
    });
    expect(h.track).toHaveBeenCalledWith('recommended_effort_applied', {
      model: 'k3',
      version: 5,
      effort: 'max',
      previous_effort: 'max',
    });
  });

  it('does nothing when thinking is explicitly disabled', async () => {
    const h = makeHarness(
      makeConfig({ thinking: { enabled: false, effort: 'high' } }),
      { k3: CAMPAIGN },
      stateFile,
    );

    await h.run();

    expect(h.fetchConfig).not.toHaveBeenCalled();
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('does nothing without a default model or its models entry', async () => {
    for (const config of [
      makeConfig({ defaultModel: undefined }),
      makeConfig({ models: undefined }),
      makeConfig({ models: {} }),
    ]) {
      const h = makeHarness(config, { k3: CAMPAIGN }, stateFile);

      await h.run();

      expect(h.setConfig).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
    }
    await expectNoStateFile(stateFile);
  });

  it('judges by config.defaultModel only, even when another alias matches the cloud list', async () => {
    const h = makeHarness(
      makeConfig({
        models: {
          main: makeModelEntry({ model: 'k3' }),
          alt: makeModelEntry({ model: 'k3-256k' }),
        },
      }),
      { 'k3-256k': CAMPAIGN },
      stateFile,
    );

    await h.run();

    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('does nothing when the model is not in the cloud config or the fetch fails', async () => {
    for (const cloud of [{}, undefined] as const) {
      const h = makeHarness(makeConfig(), cloud, stateFile);

      await h.run();

      expect(h.setConfig).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
    }
    await expectNoStateFile(stateFile);
  });

  it('matches the global official endpoint as well', async () => {
    const h = makeHarness(
      makeConfig({
        providers: { 'managed:kimi-code': { type: 'kimi', baseUrl: OFFICIAL_AI } },
      }),
      { k3: CAMPAIGN },
      stateFile,
    );

    await h.run();

    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
  });

  it('prefers the entry-level base_url over the provider one, both ways', async () => {
    const entryOfficial = makeHarness(
      makeConfig({
        providers: { 'managed:kimi-code': { type: 'kimi', baseUrl: GATEWAY } },
        models: { main: makeModelEntry({ baseUrl: OFFICIAL_COM }) },
      }),
      { k3: CAMPAIGN },
      stateFile,
    );
    await entryOfficial.run();
    expect(entryOfficial.setConfig).toHaveBeenCalledTimes(1);

    await rm(stateFile, { force: true });

    const entryGateway = makeHarness(
      makeConfig({ models: { main: makeModelEntry({ baseUrl: GATEWAY }) } }),
      { k3: CAMPAIGN },
      stateFile,
    );
    await entryGateway.run();
    expect(entryGateway.setConfig).not.toHaveBeenCalled();
    expect(entryGateway.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('does nothing for self-hosted endpoints', async () => {
    for (const config of [
      makeConfig({ providers: { 'managed:kimi-code': { type: 'kimi', baseUrl: GATEWAY } } }),
      makeConfig({ providers: { 'managed:kimi-code': { type: 'kimi' } } }),
    ]) {
      const h = makeHarness(config, { k3: CAMPAIGN }, stateFile);

      await h.run();

      expect(h.setConfig).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
    }
    await expectNoStateFile(stateFile);
  });

  it('treats KIMI_CODE_BASE_URL as the sole official benchmark when set', async () => {
    process.env['KIMI_CODE_BASE_URL'] = GATEWAY;
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('does nothing when the model does not support the recommended effort', async () => {
    for (const entry of [
      makeModelEntry({ supportEfforts: ['low', 'medium', 'high'] }),
      makeModelEntry({ supportEfforts: undefined }),
      makeModelEntry({ overrides: { supportEfforts: ['low', 'medium', 'high'] } }),
    ]) {
      const h = makeHarness(makeConfig({ models: { main: entry } }), { k3: CAMPAIGN }, stateFile);

      await h.run();

      expect(h.setConfig).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
    }
    await expectNoStateFile(stateFile);
  });

  it('applies when entry overrides widen supportEfforts to include the recommendation', async () => {
    const h = makeHarness(
      makeConfig({
        models: {
          main: makeModelEntry({
            supportEfforts: ['low', 'medium', 'high'],
            overrides: { supportEfforts: ['low', 'medium', 'high', 'max'] },
          }),
        },
      }),
      { k3: CAMPAIGN },
      stateFile,
    );

    await h.run();

    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
  });

  it('applies only a strictly newer campaign version', async () => {
    const applied = { k3: { version: 5, applied_at: '2026-09-01T00:00:00.000Z' } };
    await writeFile(stateFile, JSON.stringify(applied), 'utf-8');

    for (const version of [5, 4]) {
      const h = makeHarness(makeConfig(), { k3: { ...CAMPAIGN, version } }, stateFile);
      await h.run();
      expect(h.setConfig).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
    }
    expect(await readStateRaw(stateFile)).toEqual(applied);

    const newer = makeHarness(makeConfig(), { k3: { ...CAMPAIGN, version: 6 } }, stateFile);
    await newer.run();
    expect(newer.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 6, applied_at: NOW.toISOString() },
    });
  });

  it('applies version 0 when nothing was ever applied', async () => {
    const h = makeHarness(
      makeConfig(),
      { k3: { version: 0, recommended_default_effort: 'max' } },
      stateFile,
    );

    await h.run();

    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 0, applied_at: NOW.toISOString() },
    });
  });

  it('treats a corrupt marker file as never applied', async () => {
    await writeFile(stateFile, 'not json', 'utf-8');
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).toHaveBeenCalledWith({ thinking: { effort: 'max' } });
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 5, applied_at: NOW.toISOString() },
    });
  });

  it('keeps other models markers when recording a new one', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ 'k3-256k': { version: 2, applied_at: '2026-09-01T00:00:00.000Z' } }),
      'utf-8',
    );
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(await readStateRaw(stateFile)).toEqual({
      'k3-256k': { version: 2, applied_at: '2026-09-01T00:00:00.000Z' },
      k3: { version: 5, applied_at: NOW.toISOString() },
    });
  });

  it('re-reads the live config after the fetch and honors a mid-flight opt-out', async () => {
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);
    h.getConfig
      .mockResolvedValueOnce(makeConfig())
      .mockResolvedValueOnce(makeConfig({ thinking: { enabled: false } }));

    await h.run();

    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('reports previous_effort from the fresh config, not the pre-fetch one', async () => {
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);
    h.getConfig
      .mockResolvedValueOnce(makeConfig())
      .mockResolvedValueOnce(makeConfig({ thinking: { effort: 'medium' } }));

    await h.run();

    expect(h.track).toHaveBeenCalledWith('recommended_effort_applied', {
      model: 'k3',
      version: 5,
      effort: 'max',
      previous_effort: 'medium',
    });
  });

  it('updates the marker without writing when a stale marker meets an already-equal effort', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ k3: { version: 3, applied_at: '2026-09-01T00:00:00.000Z' } }),
      'utf-8',
    );
    const h = makeHarness(makeConfig({ thinking: { effort: 'max' } }), { k3: CAMPAIGN }, stateFile);

    await h.run();

    expect(h.setConfig).not.toHaveBeenCalled();
    expect(await readStateRaw(stateFile)).toEqual({
      k3: { version: 5, applied_at: NOW.toISOString() },
    });
    expect(h.track).toHaveBeenCalledWith('recommended_effort_applied', {
      model: 'k3',
      version: 5,
      effort: 'max',
      previous_effort: 'max',
    });
  });

  it('records no marker and reports nothing when the config write fails', async () => {
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);
    h.setConfig.mockRejectedValue(new Error('disk full'));

    await h.run();

    expect(h.track).not.toHaveBeenCalled();
    await expectNoStateFile(stateFile);
  });

  it('reports nothing when the marker write fails after a successful config write', async () => {
    const dirAsStateFile = join(dir, 'state-file-is-a-directory');
    await mkdir(dirAsStateFile);
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, dirAsStateFile);

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.setConfig).toHaveBeenCalledTimes(1);
    expect(h.track).not.toHaveBeenCalled();
  });

  it('never throws, whatever the dependencies do', async () => {
    const h = makeHarness(makeConfig(), { k3: CAMPAIGN }, stateFile);
    h.setConfig.mockRejectedValue(new Error('boom'));

    await expect(h.run()).resolves.toBeUndefined();
  });
});
