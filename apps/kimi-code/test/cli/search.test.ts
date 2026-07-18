import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  handleSearchClear,
  handleSearchSetLangSearch,
  handleSearchStatus,
  registerSearchCommand,
  type SearchDeps,
} from '#/cli/sub/search';

interface TestContext {
  readonly deps: SearchDeps;
  readonly ensureConfigFile: ReturnType<typeof vi.fn>;
  readonly getConfig: ReturnType<typeof vi.fn>;
  readonly getExperimentalFeatures: ReturnType<typeof vi.fn>;
  readonly replaceService: ReturnType<typeof vi.fn>;
  readonly setConfig: ReturnType<typeof vi.fn>;
  readonly removeService: ReturnType<typeof vi.fn>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function makeContext(config?: KimiConfig): TestContext {
  let stdout = '';
  let stderr = '';
  const resolvedConfig = config ?? { providers: {} };
  const ensureConfigFile = vi.fn(async () => {});
  const getConfig = vi.fn(async () => resolvedConfig);
  const getExperimentalFeatures = vi.fn(async () => [
    { id: 'langsearch-web-search', enabled: true },
  ]);
  const replaceService = vi.fn(async () => resolvedConfig);
  const setConfig = vi.fn(async () => resolvedConfig);
  const removeService = vi.fn(async () => resolvedConfig);
  const harness = {
    ensureConfigFile,
    getConfig,
    getExperimentalFeatures,
    replaceService,
    setConfig,
    removeService,
  } as unknown as KimiHarness;

  return {
    deps: {
      getHarness: () => harness,
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
      exit: (code: number): never => {
        throw new Error(`exit:${String(code)}`);
      },
    },
    ensureConfigFile,
    getConfig,
    getExperimentalFeatures,
    replaceService,
    setConfig,
    removeService,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('kimi search', () => {
  it('parses the nested set langsearch command and writes its config', async () => {
    const context = makeContext();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerSearchCommand(program, context.deps);

    await program.parseAsync([
      'node',
      'kimi',
      'search',
      'set',
      'langsearch',
      '--api-key',
      'sk-test',
      '--tier',
      'tier2',
      '--count',
      '10',
    ]);

    expect(context.replaceService).toHaveBeenCalledWith('langsearch', {
      apiKey: 'sk-test',
      tier: 'tier2',
      count: 10,
    });
    expect(context.stdout()).toContain('LangSearch configured: tier=tier2  count=10');
  });

  it('rejects result counts above the Web Search API maximum', async () => {
    const context = makeContext();

    await expect(
      handleSearchSetLangSearch(context.deps, {
        apiKey: 'sk-test',
        count: '11',
      }),
    ).rejects.toThrow('exit:1');

    expect(context.stderr()).toContain('Expected an integer between 1 and 10');
    expect(context.setConfig).not.toHaveBeenCalled();
  });

  it('clears LangSearch through the explicit removal API', async () => {
    const context = makeContext({
      providers: {},
      services: {
        langsearch: { apiKey: 'sk-test' },
        rerank: { enabled: true, provider: 'langsearch', apiKey: 'sk-rerank-test' },
      },
    });

    await handleSearchClear(context.deps, 'langsearch');

    expect(context.removeService).toHaveBeenCalledWith('langsearch');
    expect(context.stdout()).toContain('LangSearch web search cleared.');
  });

  it('reports an actionable status when no backend is configured', async () => {
    const context = makeContext();

    await handleSearchStatus(context.deps);

    expect(context.stdout()).toBe(
      'Web search backend: not configured\nRerank: not configured\n',
    );
  });
});
