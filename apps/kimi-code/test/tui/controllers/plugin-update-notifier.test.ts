import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import {
  PluginUpdateNotifier,
  type PluginUpdateNotifierSession,
} from '#/tui/controllers/plugin-update-notifier';
import type { PluginMarketplace } from '#/utils/plugin-marketplace';
import { readPluginUpdateNoticeState } from '#/utils/plugin-update-notice-state';

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
    originalSource: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
    ...overrides,
  };
}

function makeMarketplaceEntry(
  id: string,
  displayName: string,
  version: string,
): PluginMarketplace['plugins'][number] {
  return {
    id,
    displayName,
    source: `https://code.kimi.com/kimi-code/plugins/official/${id}.zip`,
    tier: 'official',
    version,
  };
}

function makeMarketplace(version = '3.4.0'): PluginMarketplace {
  return {
    source: KIMI_CODE_PLUGIN_MARKETPLACE_URL,
    plugins: [makeMarketplaceEntry('kimi-datasource', 'Kimi Datasource', version)],
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

    await notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);

    harness.notify.mockClear();
    // Follow-up checks run but hit the persisted "already notified" record
    // instead of notifying again.
    await notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    expect(harness.notify).not.toHaveBeenCalled();
    await notifier.handlePluginCommandCompleted('kimi-datasource');
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('ignores non-plugin tool names without touching the session', async () => {
    const harness = makeHarness();
    const notifier = makeNotifier(harness);

    await notifier.handleMcpToolCompleted('Bash');
    await notifier.handleMcpToolCompleted('mcp__github__create_issue');

    expect(harness.session.listMcpServers).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify when the installed version is up to date', async () => {
    const harness = makeHarness({ installed: [makePluginSummary({ version: '3.4.0' })] });
    const notifier = makeNotifier(harness);

    await notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    expect(harness.session.listPlugins).toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify for plugins absent from the marketplace', async () => {
    const harness = makeHarness({ installed: [makePluginSummary({ id: 'local-only' })] });
    const notifier = makeNotifier(harness);

    await notifier.handlePluginCommandCompleted('local-only');
    // No marketplace entry — the check bails before even listing plugins.
    expect(harness.session.listPlugins).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify when the catalog is not the official marketplace', async () => {
    const harness = makeHarness({
      marketplace: {
        source: 'https://example.test/custom-marketplace.json',
        plugins: [makeMarketplaceEntry('kimi-datasource', 'Kimi Datasource', '3.4.0')],
      },
    });
    const notifier = makeNotifier(harness);

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    // A custom catalog may advertise anything under any id — the check bails
    // before comparing versions.
    expect(harness.session.listPlugins).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('does not notify for a same-id fork installed from a local path', async () => {
    const harness = makeHarness({
      installed: [
        makePluginSummary({ source: 'local-path', originalSource: undefined }),
      ],
    });
    const notifier = makeNotifier(harness);

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    // Provenance is not official, so the marketplace version is irrelevant.
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('resolves plugin tools whose qualified name core truncated before the separator', async () => {
    // Server part exactly 50 chars: the 64-char truncation cuts the whole
    // `__` separator and tool name, leaving `mcp__<server>_<hash>`.
    const serverName = `plugin-kimi-datasource:${'s'.repeat(27)}`;
    const sanitized = `plugin-kimi-datasource_${'s'.repeat(27)}`;
    expect(`mcp__${sanitized}`.length).toBe(55);
    const truncatedToolName = `mcp__${sanitized}_a1b2c3d4`;

    const harness = makeHarness({ mcpServers: [serverName] });
    const notifier = makeNotifier(harness);

    await notifier.handleMcpToolCompleted(truncatedToolName);
    expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
  });

  it('notifies after a plugin command turn ends', async () => {
    const harness = makeHarness();
    const notifier = makeNotifier(harness);

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
    // Plugin commands resolve the plugin id directly — no MCP server lookup.
    expect(harness.session.listMcpServers).not.toHaveBeenCalled();
  });

  it('reminds again when the marketplace advertises a newer version', async () => {
    const first = makeHarness({ marketplace: makeMarketplace('3.4.0') });
    const notifier = makeNotifier(first);

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    expect(first.notify).toHaveBeenCalledTimes(1);

    // A new notifier (fresh app run) against the same state file stays silent
    // for the already-notified version…
    const second = makeHarness({ marketplace: makeMarketplace('3.4.0') });
    const secondNotifier = makeNotifier(second);
    await secondNotifier.handlePluginCommandCompleted('kimi-datasource');
    expect(second.notify).not.toHaveBeenCalled();

    // …but reminds once the marketplace moves to a newer version.
    const third = makeHarness({ marketplace: makeMarketplace('3.5.0') });
    const thirdNotifier = makeNotifier(third);
    await thirdNotifier.handlePluginCommandCompleted('kimi-datasource');
    expect(third.notify).toHaveBeenCalledWith(
      'Update detected: Kimi Datasource 3.5.0 is available. ' +
        'Run /plugins to install the latest version from the Official Marketplace.',
    );
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

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    expect(harness.loadMarketplace).toHaveBeenCalledTimes(1);
    expect(harness.notify).not.toHaveBeenCalled();

    await notifier.handlePluginCommandCompleted('kimi-datasource');
    expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
  });

  it('refreshes the memoized MCP server map when a lookup misses', async () => {
    const harness = makeHarness({ mcpServers: [] });
    let servers: readonly string[] = [];
    harness.session.listMcpServers = vi.fn(async () => servers.map((name) => ({ name })));
    const notifier = makeNotifier(harness);

    // The plugin's MCP server is not registered yet (the plugin gets
    // installed later in the same app run, applied on /reload or /new).
    await notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    expect(harness.session.listMcpServers).toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();

    // After the reload the new server shows up; the next completion must
    // refresh the memoized map instead of silently staying unresolved.
    servers = ['plugin-kimi-datasource:data'];
    await notifier.handleMcpToolCompleted(DATASOURCE_TOOL);
    expect(harness.notify).toHaveBeenCalledWith(EXPECTED_MESSAGE);
  });

  it('keeps every notified plugin when a turn uses two outdated plugins', async () => {
    const harness = makeHarness({
      marketplace: {
        source: KIMI_CODE_PLUGIN_MARKETPLACE_URL,
        plugins: [
          makeMarketplaceEntry('kimi-datasource', 'Kimi Datasource', '3.4.0'),
          makeMarketplaceEntry('another-plugin', 'Another Plugin', '2.0.0'),
        ],
      },
      installed: [
        makePluginSummary(),
        makePluginSummary({
          id: 'another-plugin',
          displayName: 'Another Plugin',
          version: '1.0.0',
        }),
      ],
    });
    const notifier = makeNotifier(harness);

    await Promise.all([
      notifier.handlePluginCommandCompleted('kimi-datasource'),
      notifier.handlePluginCommandCompleted('another-plugin'),
    ]);

    expect(harness.notify).toHaveBeenCalledTimes(2);
    // Both entries must survive in the persisted state — no lost update.
    const state = await readPluginUpdateNoticeState(stateFile);
    expect(state.notified).toEqual({
      'kimi-datasource': '3.4.0',
      'another-plugin': '2.0.0',
    });
  });
});
