import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  PluginUpdateNotifier,
  type PluginUpdateNotifierSession,
} from '#/tui/controllers/plugin-update-notifier';
import type { PluginMarketplace } from '#/utils/plugin-marketplace';

function makePluginSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'kimi-datasource',
    displayName: 'Kimi Datasource',
    version: '3.3.0',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 1,
    enabledMcpServerCount: 1,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'zip-url',
    ...overrides,
  };
}

function makeMarketplace(version = '3.4.0'): PluginMarketplace {
  return {
    source: 'test',
    plugins: [
      {
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        source: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
        tier: 'official',
        version,
      },
    ],
  };
}

interface HarnessOptions {
  readonly marketplace?: PluginMarketplace;
  readonly installed?: readonly PluginSummary[];
  readonly mcpServers?: readonly string[];
  readonly loadMarketplace?: () => Promise<PluginMarketplace>;
}

function makeHarness(options: HarnessOptions = {}) {
  const session: PluginUpdateNotifierSession = {
    listMcpServers: vi.fn(async () =>
      (options.mcpServers ?? ['plugin-kimi-datasource:data']).map((name) => ({ name })),
    ),
    listPlugins: vi.fn(async () => options.installed ?? [makePluginSummary()]),
  };
  const notify = vi.fn();
  const loadMarketplace = vi.fn(
    options.loadMarketplace ?? (async () => options.marketplace ?? makeMarketplace()),
  );
  return { session, notify, loadMarketplace };
}

const DATASOURCE_TOOL = 'mcp__plugin-kimi-datasource_data__call_data_source_tool';
const EXPECTED_MESSAGE =
  'Update detected: Kimi Datasource 3.4.0 is available. ' +
  'Run /plugins to install the latest version from the Official Marketplace.';

describe('PluginUpdateNotifier', () => {
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plugin-update-notifier-'));
    stateFile = join(tempDir, 'plugin-notices.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeNotifier(harness: ReturnType<typeof makeHarness>) {
    return new PluginUpdateNotifier({
      getSession: () => harness.session,
      workDir: tempDir,
      notify: harness.notify,
      loadMarketplace: harness.loadMarketplace,
      stateFile,
    });
  }

  it('notifies once after a plugin MCP tool completes, then stays silent for that version', async () => {
    const harness = makeHarness();
    const notifier = makeNotifier(harness);

    notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    await vi.waitFor(() => {
      expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
    });

    harness.notify.mockClear();
    notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    // The follow-up check runs but hits the persisted "already notified"
    // record instead of notifying again.
    await vi.waitFor(() => {
      expect(harness.session.listPlugins).toHaveBeenCalledTimes(2);
    });
    expect(harness.notify).not.toHaveBeenCalled();

    notifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(harness.session.listPlugins).toHaveBeenCalledTimes(3);
    });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('ignores non-plugin tool names without touching the session', async () => {
    const harness = makeHarness();
    const notifier = makeNotifier(harness);

    notifier.handleMcpToolCompleted('Bash');
    notifier.handleMcpToolCompleted('mcp__github__create_issue');
    await Promise.resolve();

    expect(harness.session.listMcpServers).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify when the installed version is up to date', async () => {
    const harness = makeHarness({ installed: [makePluginSummary({ version: '3.4.0' })] });
    const notifier = makeNotifier(harness);

    notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    await vi.waitFor(() => {
      expect(harness.session.listPlugins).toHaveBeenCalled();
    });
    // Let the post-check microtasks drain before asserting silence.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify for plugins absent from the marketplace', async () => {
    const harness = makeHarness({ installed: [makePluginSummary({ id: 'local-only' })] });
    const notifier = makeNotifier(harness);

    notifier.handlePluginCommandCompleted('local-only');
    await vi.waitFor(() => {
      expect(harness.loadMarketplace).toHaveBeenCalled();
    });
    // No marketplace entry — the check bails before even listing plugins.
    expect(harness.session.listPlugins).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('notifies after a plugin command turn ends', async () => {
    const harness = makeHarness();
    const notifier = makeNotifier(harness);

    notifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
    });
    // Plugin commands resolve the plugin id directly — no MCP server lookup.
    expect(harness.session.listMcpServers).not.toHaveBeenCalled();
  });

  it('reminds again when the marketplace advertises a newer version', async () => {
    const first = makeHarness({ marketplace: makeMarketplace('3.4.0') });
    const notifier = makeNotifier(first);

    notifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(first.notify).toHaveBeenCalledTimes(1);
    });

    // A new notifier (fresh app run) against the same state file stays silent
    // for the already-notified version…
    const second = makeHarness({ marketplace: makeMarketplace('3.4.0') });
    const secondNotifier = makeNotifier(second);
    secondNotifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(second.session.listPlugins).toHaveBeenCalled();
    });
    // Let the post-check microtasks drain before asserting silence.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(second.notify).not.toHaveBeenCalled();

    // …but reminds once the marketplace moves to a newer version.
    const third = makeHarness({ marketplace: makeMarketplace('3.5.0') });
    const thirdNotifier = makeNotifier(third);
    thirdNotifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(third.notify).toHaveBeenCalledWith(
        'Update detected: Kimi Datasource 3.5.0 is available. ' +
          'Run /plugins to install the latest version from the Official Marketplace.',
      );
    });
  });

  it('swallows marketplace failures and retries on the next invocation', async () => {
    let attempts = 0;
    const harness = makeHarness({
      loadMarketplace: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return makeMarketplace();
      },
    });
    const notifier = makeNotifier(harness);

    notifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(harness.loadMarketplace).toHaveBeenCalledTimes(1);
    });
    expect(harness.notify).not.toHaveBeenCalled();
    // Let the rejected check fully settle (in-flight guard released) before
    // invoking again, otherwise the retry is deduped away.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    notifier.handlePluginCommandCompleted('kimi-datasource');
    await vi.waitFor(() => {
      expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
    });
  });
});
