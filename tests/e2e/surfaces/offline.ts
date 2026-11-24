import { kimiServiceStubs, type FetchStub } from '@moonshot-ai/testkit/fixtures';

const CDN_BASES = ['https://code.kimi.com/kimi-code', 'https://code.kimi.ai/kimi-code'];
const CDN_TOOL_DOWNLOADS = ['fd', 'rg'];
const MODEL_CATALOG = 'https://models.dev/api.json';

export function offlineStubs(): FetchStub[] {
  const downloads = CDN_BASES.flatMap((base) =>
    CDN_TOOL_DOWNLOADS.map((tool) => ({ method: 'GET', url: `${base}/${tool}/`, status: 404, prefix: true })),
  );
  return [...kimiServiceStubs(), ...downloads, { method: 'GET', url: MODEL_CATALOG, status: 404 }];
}
