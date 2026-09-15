import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SURVEY_POPUP_CONFIG,
  getSurveyPopupConfig,
  peekSurveyPopupConfig,
  resetSurveyPopupConfigCache,
} from '#/utils/survey-popup-config';

const CLOUD_CONFIG = {
  probability: 0.5,
  on_for_models: ['k3', 'k2'],
  min_time_before_feedback_ms: 60_000,
  min_user_turns_before_feedback: 2,
  min_time_between_feedback_ms: 120_000,
  min_user_turns_between_feedback: 3,
  min_time_between_global_feedback_ms: 240_000,
  long_context_survey_threshold: 100_000,
  long_context_probability: 0.9,
  long_context_trigger_mode: 'virtual_context',
};

const ENVELOPE = { name: 'survey_popup', config: CLOUD_CONFIG };

const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function makeCacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'survey-popup-config-'));
  tempDirs.push(dir);
  return join(dir, 'cache.json');
}

afterEach(async () => {
  resetSurveyPopupConfigCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DEFAULT_SURVEY_POPUP_CONFIG', () => {
  it('matches the contract defaults', () => {
    expect(DEFAULT_SURVEY_POPUP_CONFIG).toEqual({
      probability: 0.005,
      on_for_models: ['*'],
      min_time_before_feedback_ms: 600_000,
      min_user_turns_before_feedback: 5,
      min_time_between_feedback_ms: 3_600_000,
      min_user_turns_between_feedback: 10,
      min_time_between_global_feedback_ms: 100_000_000,
      long_context_survey_threshold: 200_000,
      long_context_probability: 0.2,
      long_context_trigger_mode: 'cumulative',
    });
  });
});

describe('getSurveyPopupConfig', () => {
  it('POSTs the survey_popup name and returns the cloud config over the defaults', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual(CLOUD_CONFIG);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/client_configs'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'survey_popup' }),
      }),
    );
  });

  it('fills fields the cloud payload omits from the built-in defaults', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'survey_popup', config: { probability: 0.5 } }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual({ ...DEFAULT_SURVEY_POPUP_CONFIG, probability: 0.5 });
  });

  it('drops only the invalid field and keeps the rest', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'survey_popup',
        config: {
          ...CLOUD_CONFIG,
          probability: 'often',
          on_for_models: ['k3', 42],
          long_context_trigger_mode: 'sometimes',
        },
      }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual({
      ...CLOUD_CONFIG,
      probability: DEFAULT_SURVEY_POPUP_CONFIG.probability,
      on_for_models: DEFAULT_SURVEY_POPUP_CONFIG.on_for_models,
      long_context_trigger_mode: DEFAULT_SURVEY_POPUP_CONFIG.long_context_trigger_mode,
    });
  });

  it('drops negative pacing values and fractional turn counts back to defaults', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'survey_popup',
        config: {
          min_time_before_feedback_ms: -1,
          min_user_turns_before_feedback: 2.5,
          min_time_between_feedback_ms: -100,
          min_user_turns_between_feedback: -3,
          min_time_between_global_feedback_ms: -1,
        },
      }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });

  it('accepts zero pacing values as the documented no-limit semantics', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'survey_popup',
        config: {
          min_time_before_feedback_ms: 0,
          min_user_turns_before_feedback: 0,
          min_time_between_feedback_ms: 0,
          min_user_turns_between_feedback: 0,
          min_time_between_global_feedback_ms: 0,
        },
      }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual({
      ...DEFAULT_SURVEY_POPUP_CONFIG,
      min_time_before_feedback_ms: 0,
      min_user_turns_before_feedback: 0,
      min_time_between_feedback_ms: 0,
      min_user_turns_between_feedback: 0,
      min_time_between_global_feedback_ms: 0,
    });
  });

  it('drops out-of-range probabilities back to the built-in defaults', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'survey_popup',
        config: { probability: 2, long_context_probability: -0.5 },
      }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result.probability).toBe(DEFAULT_SURVEY_POPUP_CONFIG.probability);
    expect(result.long_context_probability).toBe(
      DEFAULT_SURVEY_POPUP_CONFIG.long_context_probability,
    );
  });

  it('drops a non-numeric long-context threshold back to the built-in default', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'survey_popup', config: { long_context_survey_threshold: 'never' } }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result.long_context_survey_threshold).toBe(
      DEFAULT_SURVEY_POPUP_CONFIG.long_context_survey_threshold,
    );
  });

  it('keeps a non-positive threshold so the policy layer can close the long-context arm', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'survey_popup', config: { long_context_survey_threshold: 0 } }),
    );

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result.long_context_survey_threshold).toBe(0);
  });

  it('falls back to the defaults when the payload is not an object', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'survey_popup', config: 'nope' }));

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });

  it('falls back to the defaults when the fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    const result = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });

  it('serves the in-process cache within a day and refetches after it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getSurveyPopupConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile: null });
    const cached = await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 60_000,
      cacheFile: null,
    });
    expect(cached).toEqual(CLOUD_CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await getSurveyPopupConfig({
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
      cacheFile: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('persists the fetched config to the disk cache for the next process', async () => {
    const cacheFile = await makeCacheFile();
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getSurveyPopupConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile });

    const persisted = JSON.parse(await readFile(cacheFile, 'utf-8')) as { config: unknown };
    expect(persisted.config).toEqual(CLOUD_CONFIG);

    resetSurveyPopupConfigCache();
    const result = await getSurveyPopupConfig({
      fetchImpl: vi.fn(async () => {
        throw new Error('must not fetch');
      }) as unknown as typeof fetch,
      now: now + 60_000,
      cacheFile,
    });
    expect(result).toEqual(CLOUD_CONFIG);
  });

  it('ignores a stale disk cache and falls back to the defaults when the refetch fails', async () => {
    const cacheFile = await makeCacheFile();
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getSurveyPopupConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile });
    resetSurveyPopupConfigCache();

    const result = await getSurveyPopupConfig({
      fetchImpl: vi.fn(async () => jsonResponse('no', 503)) as unknown as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
      cacheFile,
    });
    expect(result).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });
});

describe('peekSurveyPopupConfig', () => {
  it('returns the defaults while the cache is cold', () => {
    expect(peekSurveyPopupConfig()).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });

  it('sees the fetched config once the cache is warm', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getSurveyPopupConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile: null });

    expect(peekSurveyPopupConfig(now + 60_000)).toEqual(CLOUD_CONFIG);
    expect(peekSurveyPopupConfig(now + 25 * 60 * 60 * 1000)).toEqual(DEFAULT_SURVEY_POPUP_CONFIG);
  });
});
