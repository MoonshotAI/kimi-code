import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showWebSearchConfig } from '#/tui/commands/web-search';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';

type MountedPanel = {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
};

interface TestConfig {
  readonly providers?: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
}

interface HostExtras {
  harness: {
    getConfig: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    replaceService: ReturnType<typeof vi.fn>;
    removeService: ReturnType<typeof vi.fn>;
  };
  showStatus: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  mountEditorReplacement: ReturnType<typeof vi.fn>;
  restoreEditor: ReturnType<typeof vi.fn>;
  reloadCurrentSessionView: ReturnType<typeof vi.fn>;
}

const ENTER = '\r';
const ESC = '\u001B';
const UP = '\u001B[A';
const DOWN = '\u001B[B';

function makeHost(
  config: TestConfig = {},
  session?: { reloadSession: ReturnType<typeof vi.fn> },
): { host: SlashCommandHost & HostExtras; getMounted: () => MountedPanel | null } {
  let mounted: MountedPanel | null = null;
  const normalized = {
    providers: config.providers ?? {},
    services: config.services,
  };
  const host = {
    harness: {
      getConfig: vi.fn(async () => normalized),
      setConfig: vi.fn(async () => normalized),
      replaceService: vi.fn(async () => normalized),
      removeService: vi.fn(async () => normalized),
    },
    session,
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mounted = panel;
    }),
    restoreEditor: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & HostExtras;
  return { host, getMounted: () => mounted };
}

function renderedText(panel: MountedPanel): string {
  return panel.render(100).join('\n');
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function input(panel: MountedPanel, value: string): Promise<void> {
  panel.handleInput(value);
  await settle();
}

async function type(panel: MountedPanel, value: string): Promise<void> {
  for (const character of value) panel.handleInput(character);
  await settle();
}

describe('showWebSearchConfig', () => {
  beforeEach(() => {
    setExperimentalFeatures([{ id: 'langsearch-web-search', enabled: true }]);
  });

  it('shows current provider state at the top and only the two provider menus', async () => {
    const { host, getMounted } = makeHost({
      services: {
        langsearch: { apiKey: 'sk-test', tier: 'tier2' },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    const panel = getMounted();
    expect(panel).not.toBeNull();
    const text = renderedText(panel!);
    expect(text).toContain('Current web search: LangSearch (tier: tier2)');
    expect(text).toContain('Current rerank: LangSearch enabled');
    expect(text).toContain('Web search provider');
    expect(text).toContain('Rerank provider');
    expect(text).not.toContain('Show current backend');
    expect(text).not.toContain('Activate LangSearch');

    await input(panel!, ESC);
    await pending;
  });

  it('shows a missing-key warning when rerank depended on removed LangSearch config', async () => {
    const { host, getMounted } = makeHost({
      services: {
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    expect(renderedText(getMounted()!)).toContain(
      'Current rerank: LangSearch missing API key',
    );
    await input(getMounted()!, ESC);
    await pending;
  });

  it('marks the active search provider as current', async () => {
    const { host, getMounted } = makeHost({
      services: { langsearch: { apiKey: 'sk-test' } },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER);
    const text = renderedText(getMounted()!);
    expect(text).toContain('LangSearch ← current');
    expect(text).not.toContain('Moonshot ← current');

    await input(getMounted()!, ESC);
    await pending;
  });

  it('switches from LangSearch to the existing Kimi OAuth Moonshot service', async () => {
    const session = { reloadSession: vi.fn(async () => {}) };
    const { host, getMounted } = makeHost(
      {
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        services: { langsearch: { apiKey: 'sk-test' } },
      },
      session,
    );
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, UP); // Moonshot (LangSearch starts selected)
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Kimi Code OAuth');
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('moonshotSearch', {
      baseUrl: 'https://api.kimi.com/coding/v1/search',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    });
    expect(host.harness.removeService).toHaveBeenCalledWith('langsearch');
    expect(session.reloadSession).toHaveBeenCalledTimes(1);
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      session,
      'Moonshot web search configured. Session reloaded.',
    );
  });

  it('configures Moonshot manually with an automatically derived search URL', async () => {
    const { host, getMounted } = makeHost();
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, ENTER); // Moonshot
    await input(getMounted()!, ENTER); // Moonshot API key (only auth option)
    expect(renderedText(getMounted()!)).toContain('Moonshot API region');
    await input(getMounted()!, ENTER); // China
    expect(renderedText(getMounted()!)).toContain(
      'https://api.moonshot.cn/v1/search',
    );
    await type(getMounted()!, 'sk-test');
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('moonshotSearch', {
      baseUrl: 'https://api.moonshot.cn/v1/search',
      apiKey: 'sk-test',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Moonshot web search configured.');
  });

  it('switches from Moonshot to LangSearch and removes Moonshot after saving', async () => {
    const { host, getMounted } = makeHost({
      services: {
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, DOWN); // LangSearch
    await input(getMounted()!, ENTER);
    await type(getMounted()!, 'sk-langsearch');
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // free tier
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('langsearch', {
      apiKey: 'sk-langsearch',
      tier: 'free',
    });
    expect(host.harness.replaceService.mock.invocationCallOrder[0]).toBeLessThan(
      host.harness.removeService.mock.invocationCallOrder[0]!,
    );
    expect(host.harness.removeService).toHaveBeenCalledWith('moonshotSearch');
  });

  it('opens management for the current provider and removes it', async () => {
    const { host, getMounted } = makeHost({
      services: { langsearch: { apiKey: 'sk-test' } },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, ENTER); // current LangSearch
    expect(renderedText(getMounted()!)).toContain('Edit configuration');
    expect(renderedText(getMounted()!)).toContain('Remove provider');
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.removeService).toHaveBeenCalledWith('langsearch');
    expect(host.showStatus).toHaveBeenCalledWith('LangSearch web search removed.');
  });

  it('configures rerank independently while Moonshot is the search provider', async () => {
    const { host, getMounted } = makeHost({
      services: {
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // LangSearch
    await type(getMounted()!, 'sk-rerank');
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // Enabled
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: true,
      apiKey: 'sk-rerank',
    });
    expect(host.harness.removeService).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Rerank configured.');
  });

  it('edits the current rerank provider status', async () => {
    const { host, getMounted } = makeHost({
      services: {
        langsearch: { apiKey: 'sk-search' },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN); // Rerank provider
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('LangSearch ← current');
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Current status: enabled');
    await input(getMounted()!, ENTER); // Status
    expect(renderedText(getMounted()!)).toContain('Enabled ← current');
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Disabled
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: false,
    });
    expect(host.showStatus).toHaveBeenCalledWith('Rerank disabled.');
  });

  it('clears the dedicated rerank key so it reuses the search key', async () => {
    const { host, getMounted } = makeHost({
      services: {
        langsearch: { apiKey: 'sk-search' },
        rerank: {
          provider: 'langsearch',
          enabled: true,
          apiKey: 'sk-rerank',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // Current LangSearch
    await input(getMounted()!, DOWN); // API key
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // Empty means reuse search key
    await pending;

    expect(host.harness.removeService).not.toHaveBeenCalledWith('rerank');
    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: true,
      apiKey: undefined,
    });
    expect(host.showStatus).toHaveBeenCalledWith('Rerank API key updated.');
  });

  it('removes the current rerank provider from its editor', async () => {
    const { host, getMounted } = makeHost({
      services: {
        rerank: {
          provider: 'langsearch',
          enabled: false,
          apiKey: 'sk-rerank',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // Current LangSearch
    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN); // Remove provider
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.removeService).toHaveBeenCalledWith('rerank');
    expect(host.showStatus).toHaveBeenCalledWith('Rerank provider removed.');
  });
});
