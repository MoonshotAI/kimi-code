import { describe, expect, it, vi } from 'vitest';

import { IConfigService } from '#/app/config/config';
import { SUBSCRIPTION_SECTION } from '#/app/subscription/configSection';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import type { RunnableToolExecution } from '#/tool/toolContract';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';

function makeProvider(
  search: WebSearchProvider['search'],
): IWebSearchProviderService {
  return {
    _serviceBrand: undefined,
    getWebSearchProvider: () => ({ search }),
    hasWebSearchProvider: () => true,
  } as unknown as IWebSearchProviderService;
}

function makeConfig(value: Record<string, boolean> | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    get: ((domain: string) =>
      domain === SUBSCRIPTION_SECTION ? value : undefined) as IConfigService['get'],
  } as unknown as IConfigService;
}

function ctx(): { turnId: number; toolCallId: string; signal: AbortSignal } {
  return { turnId: 1, toolCallId: 't1', signal: new AbortController().signal };
}

const DISABLED_MESSAGE = 'Web search is disabled by configuration.';

describe('WebSearchTool', () => {
  it('returns a disabled error when web_search is disabled', async () => {
    const search = vi.fn(async () => []) as unknown as WebSearchProvider['search'];
    const tool = new WebSearchTool(makeProvider(search), makeConfig({ web_search: false }));

    const result = await (tool.resolveExecution({ query: 'q' }) as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toBe(DISABLED_MESSAGE);
    expect(search).not.toHaveBeenCalled();
  });

  it('reports the disabled message even when the provider reports available (backstop)', async () => {
    const search = vi.fn(async () => []) as unknown as WebSearchProvider['search'];
    const availableProvider = {
      _serviceBrand: undefined,
      getWebSearchProvider: () => ({ search }),
      hasWebSearchProvider: () => true,
    } as unknown as IWebSearchProviderService;
    const tool = new WebSearchTool(availableProvider, makeConfig({ web_search: false }));

    const result = await (tool.resolveExecution({ query: 'q' }) as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toBe(DISABLED_MESSAGE);
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the provider normally when web_search is enabled', async () => {
    const search = vi.fn(async () => [
      { title: 'T', url: 'https://example.com', snippet: 'S' },
    ]) as unknown as WebSearchProvider['search'];
    const tool = new WebSearchTool(makeProvider(search), makeConfig(undefined));

    const result = await (tool.resolveExecution({ query: 'q' }) as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('https://example.com');
    expect(search).toHaveBeenCalledTimes(1);
  });
});
