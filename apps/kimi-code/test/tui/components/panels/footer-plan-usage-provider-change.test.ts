import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent, type ManagedUsageFetcher } from '#/tui/components/chrome/footer';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/tui/constant/kimi-tui';
import type { AppState } from '#/tui/types';
import type { ManagedUsageFetchResult } from '#/tui/utils/managed-usage';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function modelAlias(provider: string, model: string): AppState['availableModels'][string] {
  return { provider, model } as AppState['availableModels'][string];
}

function footerConfig(): AppState['footer'] {
  return {
    showVersion: false,
    showPlanUsage: true,
    planUsageRefreshSeconds: 60,
  };
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '1.2.3',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    footer: footerConfig(),
    availableModels: {
      k2: modelAlias(DEFAULT_OAUTH_PROVIDER_NAME, 'k2'),
    },
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
    ...overrides,
  };
}

const USAGE_40 = {
  summary: { label: 'week', used: 40, limit: 100, resetHint: '21h' },
  limits: [],
};

const USAGE_50 = {
  summary: { label: 'week', used: 50, limit: 100, resetHint: '20h' },
  limits: [],
};

describe('FooterComponent — provider-aware plan usage polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'clears stale quota immediately and refetches when provider applicability changes',
    async () => {
      vi.useFakeTimers();
      let next: ManagedUsageFetchResult | undefined = { usage: USAGE_40 };
      const fetcher: ManagedUsageFetcher = vi.fn(async () => next);
      const footer = new FooterComponent(baseState());

      try {
        footer.setManagedUsageFetcher(fetcher);
        await vi.advanceTimersByTimeAsync(0);
        expect(strip(footer.render(120)[1]!)).toContain('40%');
        expect(fetcher).toHaveBeenCalledTimes(1);

        next = undefined;
        footer.setState(
          baseState({
            model: 'external',
            availableModels: {
              external: modelAlias('openai', 'gpt-5'),
            },
          }),
        );

        // The old provider's quota disappears synchronously, before the new
        // provider applicability check settles.
        expect(strip(footer.render(120)[1]!)).not.toContain('week');
        expect(fetcher).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(0);

        next = { usage: USAGE_50 };
        footer.setState(baseState());
        await vi.advanceTimersByTimeAsync(0);

        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(strip(footer.render(120)[1]!)).toContain('50%');
      } finally {
        footer.dispose();
      }
    },
  );

  it('ignores an obsolete in-flight response after the active model changes', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (result: ManagedUsageFetchResult | undefined) => void;
    const firstResult = new Promise<ManagedUsageFetchResult | undefined>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const fetcher: ManagedUsageFetcher = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? firstResult : { usage: USAGE_50 };
    });
    const footer = new FooterComponent(baseState());

    try {
      footer.setManagedUsageFetcher(fetcher);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      footer.setState(
        baseState({
          model: 'k2-alt',
          availableModels: {
            'k2-alt': modelAlias(DEFAULT_OAUTH_PROVIDER_NAME, 'k2-alt'),
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(strip(footer.render(120)[1]!)).toContain('50%');

      resolveFirst({ usage: USAGE_40 });
      await vi.advanceTimersByTimeAsync(0);

      expect(strip(footer.render(120)[1]!)).toContain('50%');
      expect(strip(footer.render(120)[1]!)).not.toContain('40%');
    } finally {
      footer.dispose();
    }
  });
});
