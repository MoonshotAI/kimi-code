import { describe, expect, it, vi } from 'vitest';
import {
  buildModelsRequestHeaders,
  buildModelsUrlCandidates,
  fetchProviderModels,
  parseModelsResponseBody,
  type ModelsFetchImpl,
} from '../src/lib/providerModelsFetch';

function implReturning(responses: { status: number; body: string }[]): {
  impl: ModelsFetchImpl;
  urls: string[];
} {
  const urls: string[] = [];
  const queue = [...responses];
  return {
    urls,
    impl: async ({ url }) => {
      urls.push(url);
      const next = queue.shift();
      if (next === undefined) throw new Error('unexpected request');
      return next;
    },
  };
}

describe('buildModelsUrlCandidates', () => {
  it('appends /v1/models to a plain root', () => {
    expect(buildModelsUrlCandidates('https://api.siliconflow.cn', 'openai')).toEqual([
      'https://api.siliconflow.cn/v1/models',
    ]);
  });

  it('trims trailing slashes', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/', 'openai')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('appends only /models when base already ends with /v1', () => {
    expect(buildModelsUrlCandidates('https://api.openai.com/v1', 'openai')).toEqual([
      'https://api.openai.com/v1/models',
    ]);
  });

  it('keeps non-v1 version segments and falls back to /v1/models', () => {
    expect(buildModelsUrlCandidates('https://open.bigmodel.cn/api/coding/paas/v4', 'openai')).toEqual([
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
      'https://open.bigmodel.cn/api/coding/paas/v4/v1/models',
    ]);
  });

  it('strips the /anthropic compat suffix and tries the API root', () => {
    expect(buildModelsUrlCandidates('https://api.deepseek.com/anthropic', 'anthropic')).toEqual([
      'https://api.deepseek.com/anthropic/v1/models',
      'https://api.deepseek.com/v1/models',
      'https://api.deepseek.com/models',
    ]);
  });

  it('prefers the longest matching suffix', () => {
    expect(buildModelsUrlCandidates('https://api.z.ai/api/anthropic', 'anthropic')).toEqual([
      'https://api.z.ai/api/anthropic/v1/models',
      'https://api.z.ai/v1/models',
      'https://api.z.ai/models',
    ]);
  });

  it('strips other known compat suffixes', () => {
    expect(buildModelsUrlCandidates('https://dashscope.aliyuncs.com/apps/anthropic', 'anthropic')).toEqual([
      'https://dashscope.aliyuncs.com/apps/anthropic/v1/models',
      'https://dashscope.aliyuncs.com/v1/models',
      'https://dashscope.aliyuncs.com/models',
    ]);
    expect(buildModelsUrlCandidates('https://api.stepfun.com/step_plan', 'anthropic')).toEqual([
      'https://api.stepfun.com/step_plan/v1/models',
      'https://api.stepfun.com/v1/models',
      'https://api.stepfun.com/models',
    ]);
  });

  it('does not strip unrelated path segments', () => {
    expect(buildModelsUrlCandidates('https://openrouter.ai/api', 'openai')).toEqual([
      'https://openrouter.ai/api/v1/models',
    ]);
  });

  it('uses /v1beta/models for google-genai', () => {
    expect(buildModelsUrlCandidates('https://generativelanguage.googleapis.com', 'google-genai')).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models',
    ]);
  });

  it('returns no candidates for vertexai and empty base urls', () => {
    expect(buildModelsUrlCandidates('https://example.com', 'vertexai')).toEqual([]);
    expect(buildModelsUrlCandidates('  ', 'openai')).toEqual([]);
  });

  it('deduplicates candidates', () => {
    expect(buildModelsUrlCandidates('https://host.example.com', 'openai')).toHaveLength(1);
  });
});

describe('buildModelsRequestHeaders', () => {
  it('uses a bearer token for openai-family providers', () => {
    expect(buildModelsRequestHeaders('openai', 'sk-test')).toEqual({
      authorization: 'Bearer sk-test',
    });
    expect(buildModelsRequestHeaders('kimi', 'sk-test')).toEqual({
      authorization: 'Bearer sk-test',
    });
  });

  it('uses x-api-key and anthropic headers for anthropic providers', () => {
    expect(buildModelsRequestHeaders('anthropic', 'sk-ant')).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });

  it('uses x-goog-api-key for google-genai providers', () => {
    expect(buildModelsRequestHeaders('google-genai', 'g-key')).toEqual({
      'x-goog-api-key': 'g-key',
    });
  });

  it('omits auth headers when the api key is blank', () => {
    expect(buildModelsRequestHeaders('openai', '  ')).toEqual({});
    expect(buildModelsRequestHeaders('google-genai', '')).toEqual({});
    expect(buildModelsRequestHeaders('anthropic', '')).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });
});

describe('parseModelsResponseBody', () => {
  it('parses the OpenAI data format with owned_by', () => {
    expect(
      parseModelsResponseBody(
        JSON.stringify({
          data: [
            { id: 'gpt-4.1', owned_by: 'openai' },
            { id: 'gpt-4.1-mini' },
          ],
        }),
      ),
    ).toEqual([
      { id: 'gpt-4.1', ownedBy: 'openai' },
      { id: 'gpt-4.1-mini' },
    ]);
  });

  it('falls back to the models format with slug', () => {
    expect(
      parseModelsResponseBody(JSON.stringify({ models: [{ slug: 'glm-4.6' }, { id: 'glm-4.5' }] })),
    ).toEqual([{ id: 'glm-4.5' }, { id: 'glm-4.6' }]);
  });

  it('strips the models/ prefix from google model names', () => {
    expect(
      parseModelsResponseBody(JSON.stringify({ models: [{ name: 'models/gemini-2.5-pro' }] })),
    ).toEqual([{ id: 'gemini-2.5-pro' }]);
  });

  it('tolerates a foreign-shaped models field next to data', () => {
    expect(
      parseModelsResponseBody(
        JSON.stringify({ data: [{ id: 'gpt-4.1' }], models: 'not-an-array' }),
      ),
    ).toEqual([{ id: 'gpt-4.1' }]);
  });

  it('skips malformed entries and sorts by id', () => {
    expect(
      parseModelsResponseBody(
        JSON.stringify({ data: [{ id: 'b-model' }, { nope: 1 }, null, { id: 'a-model' }] }),
      ),
    ).toEqual([{ id: 'a-model' }, { id: 'b-model' }]);
  });

  it('deduplicates repeated model ids keeping the first entry', () => {
    expect(
      parseModelsResponseBody(
        JSON.stringify({
          data: [
            { id: 'm-1', owned_by: 'first' },
            { id: 'm-2' },
            { id: 'm-1', owned_by: 'second' },
            { id: 'm-2' },
          ],
        }),
      ),
    ).toEqual([
      { id: 'm-1', ownedBy: 'first' },
      { id: 'm-2' },
    ]);
  });

  it('trims ids, drops empty names, and dedupes after normalization', () => {
    expect(
      parseModelsResponseBody(
        JSON.stringify({
          data: [
            { id: '  m-1  ' },
            { name: 'models/' },
            { id: '' },
            { id: 'm-1' },
            { name: 'models/  m-2 ' },
          ],
        }),
      ),
    ).toEqual([{ id: 'm-1' }, { id: 'm-2' }]);
  });

  it('returns an empty list for a valid empty response', () => {
    expect(parseModelsResponseBody(JSON.stringify({ data: [] }))).toEqual([]);
  });

  it('returns null for unparseable or unrecognized bodies', () => {
    expect(parseModelsResponseBody('not json')).toBeNull();
    expect(parseModelsResponseBody(JSON.stringify({ object: 'garbage' }))).toBeNull();
    expect(parseModelsResponseBody(JSON.stringify(['array']))).toBeNull();
  });
});

describe('fetchProviderModels', () => {
  const input = { type: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-test' };

  it('returns parsed models from the first successful candidate', async () => {
    const { impl, urls } = implReturning([
      { status: 200, body: JSON.stringify({ data: [{ id: 'm-1' }] }) },
    ]);
    const result = await fetchProviderModels({ ...input, impl });
    expect(result).toEqual({ ok: true, models: [{ id: 'm-1' }] });
    expect(urls).toEqual(['https://api.example.com/v1/models']);
  });

  it('falls through to the next candidate only on 404/405', async () => {
    const { impl, urls } = implReturning([
      { status: 404, body: 'not found' },
      { status: 200, body: JSON.stringify({ data: [{ id: 'm-1' }] }) },
    ]);
    const result = await fetchProviderModels({
      ...input,
      baseUrl: 'https://api.deepseek.com/anthropic',
      type: 'anthropic',
      impl,
    });
    expect(result).toEqual({ ok: true, models: [{ id: 'm-1' }] });
    expect(urls).toEqual([
      'https://api.deepseek.com/anthropic/v1/models',
      'https://api.deepseek.com/v1/models',
    ]);
  });

  it('reports not-found after all candidates are exhausted', async () => {
    const { impl } = implReturning([
      { status: 404, body: '' },
      { status: 405, body: '' },
      { status: 404, body: '' },
    ]);
    const result = await fetchProviderModels({
      ...input,
      baseUrl: 'https://api.deepseek.com/anthropic',
      type: 'anthropic',
      impl,
    });
    expect(result).toEqual({ ok: false, kind: 'notFound' });
  });

  it('stops immediately on auth failures', async () => {
    const { impl, urls } = implReturning([{ status: 401, body: 'unauthorized' }]);
    const result = await fetchProviderModels({ ...input, impl });
    expect(result).toEqual({ ok: false, kind: 'auth', status: 401 });
    expect(urls).toHaveLength(1);
  });

  it('reports other http errors with a truncated detail', async () => {
    const { impl } = implReturning([{ status: 500, body: 'x'.repeat(600) }]);
    const result = await fetchProviderModels({ ...input, impl });
    expect(result).toEqual({ ok: false, kind: 'http', status: 500, detail: 'x'.repeat(512) });
  });

  it('reports parse failures on unrecognized success bodies', async () => {
    const { impl } = implReturning([{ status: 200, body: '<html>not found</html>' }]);
    const result = await fetchProviderModels({ ...input, impl });
    expect(result).toEqual({ ok: false, kind: 'parse' });
  });

  it('classifies thrown errors as network or timeout', async () => {
    const network = await fetchProviderModels({
      ...input,
      impl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(network).toEqual({ ok: false, kind: 'network', detail: 'fetch failed' });

    const timeout = await fetchProviderModels({
      ...input,
      impl: async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      },
    });
    expect(timeout).toEqual({ ok: false, kind: 'timeout', detail: 'signal timed out' });
  });

  it('returns not-found when there are no candidates', async () => {
    const result = await fetchProviderModels({ ...input, baseUrl: '', impl: async () => {
      throw new Error('should not be called');
    } });
    expect(result).toEqual({ ok: false, kind: 'notFound' });
  });

  it('maps desktop bridge timeout results to the timeout kind', async () => {
    vi.stubGlobal('window', {
      kimiDesktop: { fetchProviderModels: async () => ({ ok: false, kind: 'timeout' }) },
    });
    try {
      const result = await fetchProviderModels(input);
      expect(result).toEqual({
        ok: false,
        kind: 'timeout',
        detail: 'desktop bridge fetch timed out',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps desktop bridge network and null results to the network kind', async () => {
    vi.stubGlobal('window', {
      kimiDesktop: { fetchProviderModels: async () => ({ ok: false, kind: 'network' }) },
    });
    try {
      const result = await fetchProviderModels(input);
      expect(result).toEqual({
        ok: false,
        kind: 'network',
        detail: 'desktop bridge fetch failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns parsed models through the desktop bridge', async () => {
    vi.stubGlobal('window', {
      kimiDesktop: {
        fetchProviderModels: async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({ data: [{ id: 'm-1' }] }),
        }),
      },
    });
    try {
      const result = await fetchProviderModels(input);
      expect(result).toEqual({ ok: true, models: [{ id: 'm-1' }] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
