import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FooterComponent,
  PLAN_USAGE_RETRY_MS,
  type ManagedUsageFetcher,
} from '#/tui/components/chrome/footer';
import { DEFAULT_FOOTER_CONFIG } from '#/tui/config';
import type { ManagedUsageFetchResult } from '#/tui/utils/managed-usage';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
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
    footer: DEFAULT_FOOTER_CONFIG,
    availableModels: {},
    ...overrides,
  } as AppState;
}

function footerConfig(overrides: Partial<AppState['footer']> = {}): AppState['footer'] {
  return {
    showVersion: false,
    showPlanUsage: true,
    planUsageRefreshSeconds: 60,
    ...overrides,
  };
}

const USAGE_REPORT = {
  summary: { label: 'week', used: 40, limit: 100, resetHint: '21h' },
  limits: [{ label: '5h', used: 4, limit: 50, resetHint: '17m' }],
};

async function settle(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injects a fetcher whose next result the test can swap at will. */
function controllableFetcher(): {
  fetcher: ManagedUsageFetcher;
  setNext(result: ManagedUsageFetchResult | undefined): void;
} {
  let next: ManagedUsageFetchResult | undefined;
  return {
    fetcher: async () => next,
    setNext(result) {
      next = result;
    },
  };
}

describe('FooterComponent — version badge', () => {
  it('renders the CLI version after the model name when enabled', () => {
    const footer = new FooterComponent(baseState({ footer: footerConfig({ showVersion: true }) }));
    try {
      const line1 = strip(footer.render(120)[0]!);
      expect(line1).toContain('v1.2.3');
      expect(line1.indexOf('k2')).toBeLessThan(line1.indexOf('v1.2.3'));
    } finally {
      footer.dispose();
    }
  });

  it('omits the version by default', () => {
    const footer = new FooterComponent(baseState());
    try {
      expect(strip(footer.render(120)[0]!)).not.toContain('v1.2.3');
    } finally {
      footer.dispose();
    }
  });
});

describe('FooterComponent — plan usage segment', () => {
  it('shows summary and rolling-window quotas left of the context readout', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();

      const line2 = strip(footer.render(120)[1]!);
      expect(line2).toContain('week');
      expect(line2).toContain('40%');
      expect(line2).toContain('(21h)');
      expect(line2).toContain('5h');
      expect(line2).toContain('8%');
      expect(line2).toContain('(17m)');
      expect(line2).toContain('context: 0%');
      // Quota left, context right.
      expect(line2.indexOf('week')).toBeLessThan(line2.indexOf('context:'));
    } finally {
      footer.dispose();
    }
  });

  it('renders no segment while the fetch never succeeds', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ error: 'boom' });
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();

      const line2 = strip(footer.render(120)[1]!);
      expect(line2).not.toContain('week');
      expect(line2).toContain('context: 0%');
    } finally {
      footer.dispose();
    }
  });

  it('renders no segment when the feature does not apply (fetcher returns undefined)', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext(undefined);
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();

      expect(strip(footer.render(120)[1]!)).not.toContain('week');
    } finally {
      footer.dispose();
    }
  });

  it('keeps the last successful data after a failed poll', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig({ planUsageRefreshSeconds: 1 }) }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();
      expect(strip(footer.render(120)[1]!)).toContain('week');

      setNext({ error: 'boom' });
      await settle(1_100);

      expect(strip(footer.render(120)[1]!)).toContain('week');
    } finally {
      footer.dispose();
    }
  });

  it('clears the segment when the provider stops being managed', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig({ planUsageRefreshSeconds: 1 }) }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();
      expect(strip(footer.render(120)[1]!)).toContain('week');

      setNext(undefined);
      await settle(1_100);

      expect(strip(footer.render(120)[1]!)).not.toContain('week');
    } finally {
      footer.dispose();
    }
  });

  it('yields the left slot to a transient hint', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();

      footer.setTransientHint('Press Ctrl-C again to exit');
      const hinted = strip(footer.render(120)[1]!);
      expect(hinted).toContain('Press Ctrl-C again to exit');
      expect(hinted).not.toContain('week');

      footer.setTransientHint(null);
      expect(strip(footer.render(120)[1]!)).toContain('week');
    } finally {
      footer.dispose();
    }
  });

  it('stops polling and hides the segment when setState disables the feature', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();
      expect(strip(footer.render(120)[1]!)).toContain('week');

      footer.setState(baseState({ footer: footerConfig({ showPlanUsage: false }) }));
      expect(strip(footer.render(120)[1]!)).not.toContain('week');

      footer.setState(baseState({ footer: footerConfig() }));
      await settle();
      expect(strip(footer.render(120)[1]!)).toContain('week');
    } finally {
      footer.dispose();
    }
  });

  it('stays quiet when enabled without an injected fetcher', async () => {
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      await settle();
      expect(strip(footer.render(120)[1]!)).not.toContain('week');
      expect(strip(footer.render(120)[1]!)).toContain('context: 0%');
    } finally {
      footer.dispose();
    }
  });

  it('drops rolling-window rows before the summary on narrow terminals', async () => {
    const { fetcher, setNext } = controllableFetcher();
    setNext({ usage: USAGE_REPORT });
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await settle();

      const full = strip(footer.render(200)[1]!);
      expect(full).toContain('5h');
      const narrow = strip(footer.render(45)[1]!);
      expect(narrow).toContain('week');
      expect(narrow).not.toContain('5h');
      expect(narrow).toContain('context: 0%');
    } finally {
      footer.dispose();
    }
  });
});


describe('FooterComponent — plan usage retry cadence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries after PLAN_USAGE_RETRY_MS while unsuccessful, then settles into the configured period', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let next: ManagedUsageFetchResult | undefined;
    const fetcher: ManagedUsageFetcher = async () => {
      calls += 1;
      return next;
    };
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      // Startup race (undefined): quick retries, not the full 60s period.
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(3);

      next = { usage: USAGE_REPORT };
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(4);
      expect(strip(footer.render(120)[1]!)).toContain('week');

      // First success switches to the configured 60s period.
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(4);
      await vi.advanceTimersByTimeAsync(55_000);
      expect(calls).toBe(5);
    } finally {
      footer.dispose();
    }
  });

  it('retries failed polls quickly while keeping the stale segment, and recovers on success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let next: ManagedUsageFetchResult | undefined = { usage: USAGE_REPORT };
    const fetcher: ManagedUsageFetcher = async () => {
      calls += 1;
      return next;
    };
    const footer = new FooterComponent(baseState({ footer: footerConfig() }));
    try {
      footer.setManagedUsageFetcher(fetcher);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      expect(strip(footer.render(120)[1]!)).toContain('week');

      next = { error: 'boom' };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      expect(strip(footer.render(120)[1]!)).toContain('week');

      // Errors also retry on the short cadence, keeping the stale data.
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(3);
      expect(strip(footer.render(120)[1]!)).toContain('week');

      next = { usage: { summary: { label: 'week', used: 50, limit: 100 }, limits: [] } };
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_RETRY_MS);
      expect(calls).toBe(4);
      expect(strip(footer.render(120)[1]!)).toContain('50%');
    } finally {
      footer.dispose();
    }
  });
});
