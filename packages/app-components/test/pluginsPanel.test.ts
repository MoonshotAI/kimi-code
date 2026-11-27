// @vitest-environment jsdom
import { computed, createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';
import type {
  AppPluginMarketplaceEntry,
  AppPluginOrigin,
  AppPluginSummary,
} from '@moonshot-ai/app-core/api';
import {
  usePlugins,
  useMcpAuthorization,
  type McpAuthorizationViewState,
  type PluginsShelfState,
  type PluginViewModel,
} from '@moonshot-ai/app-client/composables';

const fakes = vi.hoisted(() => ({
  current: null as unknown as ReturnType<typeof usePlugins>,
  authorization: null as unknown as ReturnType<typeof useMcpAuthorization>,
}));

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return {
    ...actual,
    usePlugins: () => fakes.current,
    useMcpAuthorization: () => fakes.authorization,
  };
});

vi.mock('@moonshot-ai/app-client/client', () => ({
  connectEventsIfNeeded: vi.fn(),
}));

import PluginsPanel from '../src/settings/PluginsPanel.vue';

let authorization: ReturnType<typeof useMcpAuthorization>;

function makeAuthorization(): ReturnType<typeof useMcpAuthorization> {
  return {
    states: reactive<Record<string, McpAuthorizationViewState>>({}),
    refresh: vi.fn(async () => {}),
    authorize: vi.fn(async () => {}),
    authorizePlugin: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  };
}

let app: App | null = null;
let host: HTMLDivElement;
let plugins: ReturnType<typeof usePlugins>;
let rowData: PluginViewModel[];

function entry(
  id: string,
  displayName: string,
  overrides: Partial<AppPluginMarketplaceEntry> = {},
): AppPluginMarketplaceEntry {
  return {
    id,
    tier: 'official',
    displayName,
    source: `${id}.zip`,
    ...overrides,
  };
}

function installed(
  id: string,
  origin: AppPluginOrigin,
  overrides: Partial<AppPluginSummary> = {},
): AppPluginSummary {
  return {
    id,
    displayName: id,
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    origin,
    installedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function row(
  id: string,
  overrides: Partial<PluginViewModel> = {},
): PluginViewModel {
  return {
    id,
    installId: id,
    capabilityRequired: false,
    capabilityUnavailable: false,
    cloudOnly: false,
    official: true,
    displayName: id,
    updateAvailable: false,
    ...overrides,
  };
}

function makePlugins(rows: PluginViewModel[]): ReturnType<typeof usePlugins> {
  const state = reactive<PluginsShelfState>({
    entries: [],
    installed: [],
    capabilities: [],
    loaded: true,
    loading: false,
    error: null,
    catalogError: null,
    unsupported: false,
    capabilitiesUnsupported: false,
    capabilitiesLoadFailed: false,
    extensionHint: false,
    busy: {},
    rowErrors: {},
  });
  const allRows = computed(() => rows);
  const marketplaceRows = computed(() =>
    allRows.value.filter((item) => item.catalogEntry !== undefined || item.capability !== undefined),
  );
  const installedRows = computed(() =>
    allRows.value.filter((item) => item.installedPlugin !== undefined),
  );
  const installedGroup = (item: PluginViewModel): 'custom' | 'marketplace' => {
    const origin = item.installedPlugin?.origin;
    if (origin === 'custom' || origin === 'marketplace') return origin;
    return item.catalogEntry === undefined ? 'custom' : 'marketplace';
  };
  return {
    state,
    rows: allRows,
    marketplaceRows,
    officialRows: computed(() => marketplaceRows.value.filter((item) => item.official)),
    curatedRows: computed(() => marketplaceRows.value.filter((item) => !item.official)),
    capabilityRows: computed(() => marketplaceRows.value.filter((item) => item.capabilityRequired)),
    installedRows,
    installedGroups: computed(() => ({
      marketplace: installedRows.value.filter((item) => installedGroup(item) === 'marketplace'),
      custom: installedRows.value.filter((item) => installedGroup(item) === 'custom'),
    })),
    loadPluginCapabilities: vi.fn(async () => ({ skills: [], mcpServers: [] })),
    probeSupport: vi.fn(async () => {}),
    clearRowErrors: vi.fn(() => {
      state.rowErrors = {};
    }),
    refresh: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    installRow: vi.fn(async () => {}),
    installSource: vi.fn(async (source: string) => {
      if (source === 'bad') {
        state.rowErrors.__custom__ = 'bad zip';
        return;
      }
      rows.push(row('custom-plugin', {
        installedPlugin: installed('custom-plugin', 'custom', { displayName: 'Custom plugin' }),
        displayName: 'Custom plugin',
        official: false,
      }));
    }),
    setupCapability: vi.fn(async () => {}),
    dismissExtensionHint: vi.fn(() => {
      state.extensionHint = false;
    }),
    remove: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    busyKey: (id: string, action: 'install' | 'remove' | 'toggle') => `${id}:${action}`,
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  rowData = reactive<PluginViewModel[]>([]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await nextTick();
}

async function hoverTooltipText(target: Element | null): Promise<string | undefined> {
  vi.useFakeTimers();
  try {
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    target?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
    vi.advanceTimersByTime(200);
  } finally {
    vi.useRealTimers();
  }
  await settle();
  return document.querySelector('.ui-tip__bubble')?.textContent ?? undefined;
}

async function mountPanel(locale: 'en' | 'zh' = 'en'): Promise<void> {
  plugins = makePlugins(rowData);
  authorization = makeAuthorization();
  fakes.current = plugins;
  fakes.authorization = authorization;
  app = createApp({ render: () => h(PluginsPanel) });
  app.use(createKimiI18n({ locale }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button')];
}

function customDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Install custom plugin"]',
  );
}

function clickButton(label: string): void {
  const button = buttons().find((candidate) => candidate.textContent?.trim().includes(label));
  expect(button, label).not.toBeUndefined();
  button!.click();
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('PluginsPanel', () => {
  it('filters marketplace rows in real time by name and displayed description', async () => {
    rowData.push(
      row('vercel', {
        catalogEntry: entry('vercel', 'Vercel'),
        displayName: 'Vercel',
        shortDescription: 'Deploy applications',
      }),
      row('cloudbase', {
        catalogEntry: entry('cloudbase', 'CloudBase'),
        displayName: 'CloudBase',
        shortDescription: 'Cloud services',
      }),
      row('superpowers', {
        catalogEntry: entry('superpowers', 'Superpowers', { tier: 'curated' }),
        displayName: 'Superpowers',
        shortDescription: 'Extra skills',
        official: false,
      }),
    );
    await mountPanel();
    expect(host.querySelectorAll('.plugin-row')).toHaveLength(3);

    const search = host.querySelector<HTMLInputElement>('.pp-search input')!;
    await setInput(search, 'deploy');
    expect([...host.querySelectorAll('.plugin-row__name')].map((el) => el.textContent)).toEqual(['Vercel']);

    await setInput(search, 'super');
    expect([...host.querySelectorAll('.plugin-row__name')].map((el) => el.textContent)).toEqual(['Superpowers']);

    await setInput(search, 'missing');
    expect(host.querySelectorAll('.plugin-row')).toHaveLength(0);
    expect(host.textContent).toContain('No matching plugins');
  });

  it('keeps the search slot stable across views and shortens the English marketplace tab', async () => {
    await mountPanel();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs[0]?.textContent?.trim()).toBe('Marketplace');
    const search = host.querySelector<HTMLElement>('.pp-search')!;
    const input = search.querySelector<HTMLInputElement>('input')!;
    expect(search.classList.contains('pp-search--hidden')).toBe(false);
    expect(input.disabled).toBe(false);

    tabs[1]!.click();
    await nextTick();

    expect(host.querySelector('.pp-search')).toBe(search);
    expect(search.classList.contains('pp-search--hidden')).toBe(true);
    expect(search.getAttribute('aria-hidden')).toBe('true');
    expect(search.hasAttribute('inert')).toBe(true);
    expect(input.disabled).toBe(true);

    tabs[0]!.click();
    await nextTick();

    expect(host.querySelector('.pp-search')).toBe(search);
    expect(search.classList.contains('pp-search--hidden')).toBe(false);
    expect(search.hasAttribute('inert')).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it('separates short and long descriptions and falls back when an icon fails to load', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', {
        iconUrl: 'https://cdn.example.test/vercel.png',
        homepage: 'https://vercel.com',
      }),
      displayName: 'Vercel',
      shortDescription: 'Short text',
      longDescription: 'Long plugin introduction',
      iconUrl: 'https://cdn.example.test/vercel.png',
    }));
    await mountPanel();

    expect(host.querySelector('.plugin-row__main')?.textContent).toContain('Short text');
    expect(host.querySelector('.plugin-row__main')?.textContent).not.toContain('Long plugin introduction');
    const image = host.querySelector<HTMLImageElement>('.plugin-icon__image')!;
    expect(image).not.toBeNull();
    image.dispatchEvent(new Event('error'));
    await nextTick();
    expect(host.querySelector('.plugin-icon__image')).toBeNull();

    const rowButton = host.querySelector<HTMLButtonElement>('.plugin-row__main')!;
    rowButton.focus();
    rowButton.click();
    await settle();
    const backButton = host.querySelector<HTMLButtonElement>(
      '.plugin-details__header [aria-label="Back"]',
    )!;
    expect(document.activeElement).toBe(backButton);
    expect(host.querySelector('.plugin-details__tagline')?.textContent).toBe('Short text');
    expect(host.querySelector('.plugin-details__description')?.textContent).toBe('Long plugin introduction');
    expect(host.querySelector('.plugin-details')?.textContent).toContain('Official');
    expect(host.querySelector('.plugin-details')?.textContent).not.toContain('MCP server');

    backButton.click();
    await settle();
    expect(host.querySelector('.plugin-details')).toBeNull();
    expect(host.querySelector('.plugin-row')).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.plugin-row__main'));
    expect((document.activeElement as HTMLElement).dataset.pluginRow).toBe('vercel');
  });

  it('silences manifest diagnostics without hiding operation errors', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace', { hasErrors: true }),
      displayName: 'Vercel',
    }));
    await mountPanel();

    expect(host.querySelector('.plugin-status')).toBeNull();

    clickButton('Vercel');
    await settle();
    expect(host.querySelector('.plugin-status')).toBeNull();

    plugins.state.rowErrors.vercel = 'operation failed';
    await nextTick();
    expect(host.querySelector('.plugin-status__error')?.textContent).toBe('operation failed');
  });

  it('keeps official labeling for an installed capability without a catalog entry', async () => {
    rowData.push(row('kimi-browser-extension', {
      installedPlugin: installed('kimi-browser-extension', 'unknown'),
      capability: {
        id: 'kimi-webbridge',
        pluginId: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        description: 'Browser control',
        supported: true,
        state: 'ready',
        steps: [],
        install: { running: false },
      },
      displayName: 'Kimi Browser Extension',
    }));
    await mountPanel();

    clickButton('Kimi Browser Extension');
    await settle();

    expect(host.querySelector('.plugin-details')?.textContent).toContain('Official');
    expect(host.querySelector('.plugin-details')?.textContent).not.toContain('Custom');
    expect(host.querySelector('.plugin-details__badge--official')).not.toBeNull();
  });

  it('renders capability overrides and falls back to the MCP icon when its image fails', async () => {
    rowData.push(row('kimi-cu', {
      catalogEntry: entry('kimi-cu', 'Kimi Computer Use'),
      installedPlugin: installed('kimi-cu', 'unknown'),
      displayName: 'Kimi Computer Use',
      shortDescription: 'Background GUI automation',
      longDescription: 'Full GUI automation introduction',
    }));
    await mountPanel();
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [{
        name: 'kimi-cu',
        displayName: 'Kimi Computer Use',
        description: 'Short GUI usage guide',
      }],
      mcpServers: [{
        name: 'mac',
        displayName: 'Kimi Computer Use',
        description: 'Background GUI operations',
        iconUrl: 'https://cdn.example.test/kimi-cu.png',
        runtimeName: 'plugin-kimi-cu:mac',
        enabled: true,
        transport: 'stdio',
      }],
    });

    clickButton('Kimi Computer Use');
    await settle();

    const details = host.querySelector('.plugin-details');
    expect(details?.textContent).toContain('Plugin marketplace / Kimi Computer Use');
    expect(details?.textContent).toContain('Official');
    expect(details?.textContent).toContain('Introduction');
    expect(details?.textContent).toContain('Full GUI automation introduction');
    expect(details?.textContent).toContain('Capabilities');
    expect(details?.textContent).toContain('Apps');
    expect(details?.textContent).toContain('Background GUI operations');
    expect(details?.textContent).toContain('Skills');
    expect(details?.textContent).toContain('Short GUI usage guide');
    const capabilityItems = details?.querySelectorAll('.plugin-capabilities__item');
    expect(capabilityItems?.[1]?.innerHTML).toContain('M16.5001 8.2002');
    expect(capabilityItems?.[0]?.querySelector('.plugin-capabilities__name')?.textContent).toBe('Kimi Computer Use');
    expect(capabilityItems?.[0]?.querySelector('.plugin-capabilities__description')?.textContent).toBe('Background GUI operations');
    expect(capabilityItems?.[1]?.querySelector('.plugin-capabilities__name')?.textContent).toBe('Kimi Computer Use');
    expect(capabilityItems?.[1]?.querySelector('.plugin-capabilities__description')?.textContent).toBe('Short GUI usage guide');
    const image = capabilityItems?.[0]?.querySelector<HTMLImageElement>('img');
    expect(image?.src).toBe('https://cdn.example.test/kimi-cu.png');
    image?.dispatchEvent(new Event('error'));
    await nextTick();
    expect(capabilityItems?.[0]?.querySelector('img')).toBeNull();
    expect(capabilityItems?.[0]?.innerHTML).toContain('M12.4745 3.09473');
    expect(details?.textContent).not.toContain('Other');
    expect(plugins.loadPluginCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kimi-cu' }),
      'marketplace',
    );
  });

  it('retries capability loading in place after a failure', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    vi.mocked(plugins.loadPluginCapabilities)
      .mockRejectedValueOnce(new Error('capabilities unavailable'))
      .mockResolvedValueOnce({
        skills: [{ name: 'vercel', description: 'Loaded capability' }],
        mcpServers: [],
      });
    clickButton('Vercel');
    await settle();
    expect(host.querySelector('.plugin-capabilities__error')?.textContent).toContain(
      'capabilities unavailable',
    );

    host.querySelector<HTMLButtonElement>('.plugin-capabilities__error button')!.click();
    await settle();

    expect(plugins.loadPluginCapabilities).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.plugin-capabilities')?.textContent).toContain('Loaded capability');
    expect(host.querySelector('.plugin-capabilities')?.textContent).not.toContain(
      'capabilities unavailable',
    );
  });

  it('omits the MCP description and transport when a description is missing', async () => {
    rowData.push(row('kimi-cu', {
      catalogEntry: entry('kimi-cu', 'Kimi Computer Use'),
      installedPlugin: installed('kimi-cu', 'unknown'),
      displayName: 'Kimi Computer Use',
    }));
    await mountPanel();
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'mac',
        displayName: 'Kimi Computer Use',
        runtimeName: 'plugin-kimi-cu:mac',
        enabled: true,
        transport: 'stdio',
      }],
    });

    clickButton('Kimi Computer Use');
    await settle();

    const item = host.querySelector('.plugin-capabilities__item');
    expect(item?.querySelector('.plugin-capabilities__description')).toBeNull();
    expect(item?.textContent).not.toContain('stdio');
  });

  it('uses My plugins as the breadcrumb parent for catalog plugins opened from installed view', async () => {
    rowData.push(row('cloudbase', {
      catalogEntry: entry('cloudbase', 'CloudBase'),
      installedPlugin: installed('cloudbase', 'marketplace'),
      displayName: 'CloudBase',
    }));
    await mountPanel();

    buttons().find((button) => button.textContent?.includes('My plugins'))!.click();
    await nextTick();
    clickButton('CloudBase');
    await settle();

    expect(host.querySelector('.plugin-details__title')?.textContent).toBe('My plugins / CloudBase');

    host.querySelector<HTMLButtonElement>('.plugin-details__header [aria-label="Back"]')!.click();
    await settle();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('My plugins');
  });

  it('keeps installed details selected when catalog rows change ids', async () => {
    const merged = row('vercel-catalog', {
      catalogEntry: entry('vercel-catalog', 'Vercel'),
      installedPlugin: installed('vercel-package', 'marketplace', { catalogId: 'vercel-catalog' }),
      displayName: 'Vercel',
    });
    rowData.push(merged);
    await mountPanel();
    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();

    rowData[0] = row('vercel-package', {
      ...merged,
      id: 'vercel-package',
      installId: 'vercel-package',
      catalogEntry: undefined,
    });
    await settle();
    expect(host.querySelector('.plugin-details')).not.toBeNull();

    rowData[0] = merged;
    await settle();
    expect(host.querySelector('.plugin-details')).not.toBeNull();
  });

  it('closes removed marketplace details after settlement and focuses the installed tab', async () => {
    rowData.push(row('custom-plugin', {
      catalogEntry: entry('custom-plugin', 'Custom plugin'),
      installedPlugin: installed('custom-plugin', 'marketplace'),
      displayName: 'Custom plugin',
      official: false,
    }));
    await mountPanel();
    buttons().find((button) => button.textContent?.includes('My plugins'))!.click();
    await nextTick();
    clickButton('Custom plugin');
    await settle();
    let finishRemoval!: () => void;
    vi.mocked(plugins.remove).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishRemoval = resolve;
      });
      rowData[0] = { ...rowData[0]!, installedPlugin: undefined };
    });

    host.querySelector<HTMLButtonElement>('.plugin-details [aria-label="More actions"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('.plugin-details .plugin-actions__menu .ui-menu-item')!.click();
    await settle();
    expect(plugins.remove).not.toHaveBeenCalled();
    const confirmation = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Uninstall plugin"]',
    )!;
    expect(confirmation.textContent).toContain('Custom plugin');
    confirmation.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.click();
    await nextTick();
    expect(plugins.remove).toHaveBeenCalledWith('custom-plugin');
    expect(host.querySelector('.plugin-details')).not.toBeNull();

    finishRemoval();
    await settle();

    expect(plugins.remove).toHaveBeenCalledWith('custom-plugin');
    expect(host.querySelector('.plugin-details')).toBeNull();
    const selectedTab = host.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    expect(selectedTab.textContent?.trim()).toBe('My plugins');
    expect(document.activeElement).toBe(selectedTab);
  });

  it('restores the more-actions trigger focus after a failed uninstall', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    clickButton('Vercel');
    await settle();
    const trigger = host.querySelector<HTMLButtonElement>('.plugin-details [aria-label="More actions"]')!;
    trigger.focus();
    trigger.click();
    await settle();
    host.querySelector<HTMLButtonElement>('.plugin-details .plugin-actions__menu .ui-menu-item')!.click();
    await settle();
    plugins.state.rowErrors['vercel'] = 'network down';
    document.body.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.click();
    await settle();

    expect(plugins.remove).toHaveBeenCalledWith('vercel');
    expect(host.querySelector('.plugin-details')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes marketplace details when the catalog entry disappears', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    clickButton('Vercel');
    await settle();
    expect(host.querySelector('.plugin-details')).not.toBeNull();

    rowData[0] = { ...rowData[0]!, catalogEntry: undefined };
    await settle();

    expect(host.querySelector('.plugin-details')).toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('Marketplace');
  });

  it('offers a retry when capability loading fails', async () => {
    await mountPanel();
    plugins.state.capabilitiesLoadFailed = true;
    await nextTick();

    const notice = host.querySelector('.pp-notice')!;
    expect(notice.textContent).toContain('Retry');
    notice.querySelector<HTMLButtonElement>('button')!.click();
    expect(plugins.refresh).toHaveBeenCalledWith(true);
  });

  it('shows installed and target versions with the English uninstall label', async () => {
    rowData.push(row('cloudbase', {
      catalogEntry: entry('cloudbase', 'CloudBase', { version: '2.0.0' }),
      installedPlugin: installed('cloudbase', 'marketplace', { version: '1.2.3' }),
      displayName: 'CloudBase',
      updateAvailable: true,
    }));
    await mountPanel();

    clickButton('CloudBase');
    await settle();

    const details = host.querySelector('.plugin-details');
    expect(details?.querySelector('.plugin-details__version')?.textContent).toBe('v1.2.3');
    expect(details?.querySelector('.plugin-details__version--update')?.textContent?.trim()).toBe(
      'Update to v2.0.0',
    );
    expect(details?.querySelector('.plugin-actions .ui-button')?.textContent).toContain('Update');

    host.querySelector<HTMLButtonElement>('.plugin-actions [aria-label="More actions"]')!.click();
    await settle();
    expect(host.querySelector('.plugin-actions__menu .ui-menu-item')?.textContent).toContain('Uninstall');
  });

  it('shows marketplace and custom groups without an other section', async () => {
    rowData.push(
      row('custom', { installedPlugin: installed('custom', 'custom'), displayName: 'Custom' }),
      row('market', { installedPlugin: installed('market', 'marketplace'), displayName: 'Market' }),
      row('unknown', { installedPlugin: installed('unknown', 'unknown'), displayName: 'Unknown' }),
    );
    await mountPanel();

    const tab = buttons().find((button) => button.textContent?.includes('My plugins'))!;
    tab.click();
    await nextTick();

    const sections = [...host.querySelectorAll<HTMLElement>('.pp-installed-section')];
    expect(sections.map((section) => section.dataset.origin)).toEqual(['custom', 'marketplace']);
    expect(sections[0]?.textContent).toContain('Custom');
    expect(sections[0]?.textContent).toContain('Unknown');
    expect(sections[0]?.querySelector('.plugin-row__description')).toBeNull();
    expect(sections[0]?.querySelector('.plugin-icon')?.innerHTML).toContain('M15.3128 3.17132');
    expect(sections[1]?.textContent).toContain('Plugin marketplace');
    expect(sections[1]?.textContent).toContain('Market');
  });

  it('opens custom install in a modal and restores focus on Escape', async () => {
    const parentKeydown = vi.fn();
    document.addEventListener('keydown', parentKeydown);
    try {
      await mountPanel();
      const trigger = buttons().find((button) => button.textContent?.includes('Install custom plugin'))!;
      trigger.focus();
      trigger.click();
      await settle();

      const dialog = customDialog();
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(host.querySelector('.pp-custom-form')).toBeNull();
      const input = dialog?.querySelector<HTMLInputElement>('input');
      expect(document.activeElement).toBe(input);

      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();

      expect(customDialog()).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(parentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', parentKeydown);
    }
  });

  it('locks custom install modal dismissal while busy', async () => {
    const parentKeydown = vi.fn();
    document.addEventListener('keydown', parentKeydown);
    try {
      await mountPanel();
      clickButton('Install custom plugin');
      await settle();
      const dialog = customDialog()!;
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Cancel')!;

      plugins.state.busy['__custom__:install'] = true;
      await nextTick();

      expect(dialog.querySelector('input')?.disabled).toBe(true);
      expect(dialog.querySelector('.ui-dialog__close')).toBeNull();
      expect(cancel.disabled).toBe(true);
      dialog.querySelector('input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
      expect(customDialog()).not.toBeNull();
      expect(parentKeydown).not.toHaveBeenCalled();

      plugins.state.busy['__custom__:install'] = undefined;
      await nextTick();
      cancel.click();
      await settle();
      expect(customDialog()).toBeNull();
    } finally {
      document.removeEventListener('keydown', parentKeydown);
    }
  });

  it('switches to the custom group after a successful custom install', async () => {
    await mountPanel();
    clickButton('Install custom plugin');
    await settle();
    const dialog = customDialog()!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    await setInput(input, 'https://example.test/custom.zip');

    dialog.querySelector<HTMLFormElement>('.pp-custom-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(plugins.installSource).toHaveBeenCalledWith('https://example.test/custom.zip');
    expect(customDialog()).toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('My plugins');
    expect(host.querySelector('[data-origin="custom"]')?.textContent).toContain('Custom plugin');
  });

  it('keeps custom install errors in the modal', async () => {
    await mountPanel();
    clickButton('Install custom plugin');
    await settle();
    const dialog = customDialog()!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    await setInput(input, 'bad');

    dialog.querySelector<HTMLFormElement>('.pp-custom-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(customDialog()).not.toBeNull();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('bad zip');
  });

  it('shows the missing manifest error in Chinese without changing other errors', async () => {
    const source = 'https://github.com/example/custom-plugin';
    await mountPanel('zh');
    clickButton('安装自定义插件');
    await settle();

    plugins.state.rowErrors.__custom__ = `Cannot install plugin from ${source}: No manifest at kimi.plugin.json or .kimi-plugin/plugin.json`;
    await nextTick();
    expect(document.body.querySelector('.pp-error')?.textContent).toBe(
      `无法从 ${source} 安装插件：缺少插件声明文件。请在插件根目录添加 kimi.plugin.json，或添加 .kimi-plugin/plugin.json 后重试。`,
    );

    plugins.state.rowErrors.__custom__ = 'bad zip';
    await nextTick();
    expect(document.body.querySelector('.pp-error')?.textContent).toBe('bad zip');
  });

  it('keeps the missing manifest error unchanged in English', async () => {
    const source = 'https://github.com/example/custom-plugin';
    const error = `Cannot install plugin from ${source}: No manifest at kimi.plugin.json or .kimi-plugin/plugin.json`;
    rowData.push(row('broken', {
      catalogEntry: entry('broken', 'Broken'),
      displayName: 'Broken',
    }));
    await mountPanel();

    plugins.state.rowErrors.broken = error;
    await nextTick();
    expect(host.querySelector('.plugin-status__error')?.textContent).toBe(error);
  });

  it('keeps partial installed capabilities on toggle and remove without repair or steps', async () => {
    rowData.push(row('kimi-cu', {
      installId: 'kimi-cu',
      catalogEntry: entry('kimi-cu', 'Kimi Computer Use', { capabilityId: 'kimi-cu' }),
      installedPlugin: installed('kimi-cu', 'marketplace'),
      capability: {
        id: 'kimi-cu',
        pluginId: 'kimi-cu',
        displayName: 'Kimi Computer Use',
        description: 'Computer control',
        supported: true,
        state: 'partial',
        steps: [{ id: 'permissions.accessibility', state: 'missing', detail: 'denied' }],
        install: { running: false },
      },
      capabilityRequired: true,
      displayName: 'Kimi Computer Use',
    }));
    await mountPanel();

    expect(host.querySelector('.plugin-row .plugin-actions .ui-button')).toBeNull();
    expect(host.querySelector('.plugin-row .plugin-actions [role="switch"]')).not.toBeNull();
    expect(host.querySelector('.plugin-row .plugin-actions [aria-label="More actions"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Repair');
    expect(host.textContent).not.toContain('Incomplete steps');
    expect(host.textContent).not.toContain('Accessibility permission');
    expect(host.textContent).not.toContain('denied');
    expect(plugins.installRow).not.toHaveBeenCalled();

    rowData[0]!.capability!.install = { running: true, step: 'daemon', percent: 42 };
    await nextTick();
    expect(host.querySelector('.plugin-row .plugin-actions .ui-button')?.textContent).toContain('Installing');
    expect(host.querySelector('.plugin-row .plugin-actions [role="switch"]')).toBeNull();
    expect(host.querySelector('.plugin-row .plugin-actions [aria-label="More actions"]')).toBeNull();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(host.textContent).not.toContain('Background service');
    expect(host.textContent).not.toContain('42%');
  });

  it('shows only the installing status while a capability install is running and restores actions after settlement', async () => {
    rowData.push(row('kimi-browser-extension', {
      installId: 'kimi-webbridge',
      catalogEntry: entry('kimi-browser-extension', 'Kimi Browser Extension', {
        capabilityId: 'kimi-webbridge',
        version: '1.11.3',
      }),
      installedPlugin: installed('kimi-browser-extension', 'marketplace', { version: '1.11.3' }),
      capability: {
        id: 'kimi-webbridge',
        pluginId: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        description: 'Browser control',
        supported: true,
        state: 'partial',
        steps: [{ id: 'skill', state: 'ok' }, { id: 'daemon', state: 'missing' }],
        install: { running: true, step: 'daemon' },
      },
      capabilityRequired: true,
      displayName: 'Kimi Browser Extension',
    }));
    await mountPanel();

    const rowActions = '.plugin-row .plugin-actions';
    expect(host.querySelector(`${rowActions} .ui-button`)?.textContent).toContain('Installing');
    expect(host.querySelector<HTMLButtonElement>(`${rowActions} .ui-button`)?.disabled).toBe(true);
    expect(host.querySelector(`${rowActions} [role="switch"]`)).toBeNull();
    expect(host.querySelector(`${rowActions} [aria-label="More actions"]`)).toBeNull();

    clickButton('Kimi Browser Extension');
    await settle();
    const detailActions = '.plugin-details .plugin-actions';
    expect(host.querySelector(`${detailActions} .ui-button`)?.textContent).toContain('Installing');
    expect(host.querySelector<HTMLButtonElement>(`${detailActions} .ui-button`)?.disabled).toBe(true);
    expect(host.querySelector(`${detailActions} [role="switch"]`)).toBeNull();
    expect(host.querySelector(`${detailActions} [aria-label="More actions"]`)).toBeNull();

    rowData[0]!.capability = {
      ...rowData[0]!.capability!,
      state: 'ready',
      install: { running: false },
    };
    await settle();

    expect(host.querySelector(`${detailActions} .ui-button`)).toBeNull();
    expect(host.querySelector(`${detailActions} [role="switch"]`)).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(`${detailActions} [role="switch"]`)?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(`${detailActions} [aria-label="More actions"]`)?.disabled).toBe(false);

    host.querySelector<HTMLButtonElement>('.plugin-details__header [aria-label="Back"]')!.click();
    await settle();
    expect(host.querySelector(`${rowActions} .ui-button`)).toBeNull();
    expect(host.querySelector(`${rowActions} [role="switch"]`)).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(`${rowActions} [role="switch"]`)?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(`${rowActions} [aria-label="More actions"]`)?.disabled).toBe(false);
  });

  it('shows only the installing status during a marketplace update and restores actions when it fails or succeeds', async () => {
    const updateRow = row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', { version: '2.0.0' }),
      installedPlugin: installed('vercel', 'marketplace', { version: '1.0.0' }),
      displayName: 'Vercel',
      updateAvailable: true,
    });
    rowData.push(updateRow);
    await mountPanel();

    plugins.state.busy['vercel:install'] = true;
    await nextTick();

    const rowActions = '.plugin-row .plugin-actions';
    expect(host.querySelector(`${rowActions} .ui-button`)?.textContent).toContain('Installing');
    expect(host.querySelector(`${rowActions} [role="switch"]`)).toBeNull();
    expect(host.querySelector(`${rowActions} [aria-label="More actions"]`)).toBeNull();

    clickButton('Vercel');
    await settle();
    const detailActions = '.plugin-details .plugin-actions';
    expect(host.querySelector(`${detailActions} .ui-button`)?.textContent).toContain('Installing');
    expect(host.querySelector(`${detailActions} [role="switch"]`)).toBeNull();
    expect(host.querySelector(`${detailActions} [aria-label="More actions"]`)).toBeNull();

    plugins.state.busy['vercel:install'] = undefined;
    plugins.state.rowErrors['vercel'] = 'network down';
    await settle();

    expect(host.querySelector(`${detailActions} .ui-button`)?.textContent).toContain('Update');
    expect(host.querySelector<HTMLButtonElement>(`${detailActions} .ui-button`)?.disabled).toBe(false);
    expect(host.querySelector(`${detailActions} [role="switch"]`)).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(`${detailActions} [aria-label="More actions"]`)?.disabled).toBe(false);
    expect(host.querySelector('.plugin-details .plugin-status__error')?.textContent).toBe('network down');

    host.querySelector<HTMLButtonElement>('.plugin-details__header [aria-label="Back"]')!.click();
    await settle();
    expect(host.querySelector(`${rowActions} .ui-button`)?.textContent).toContain('Update');
    expect(host.querySelector(`${rowActions} [role="switch"]`)).not.toBeNull();
    expect(host.querySelector(`${rowActions} [aria-label="More actions"]`)).not.toBeNull();

    plugins.state.rowErrors['vercel'] = undefined;
    plugins.state.busy['vercel:install'] = true;
    await nextTick();
    expect(host.querySelector(`${rowActions} [role="switch"]`)).toBeNull();
    expect(host.querySelector(`${rowActions} [aria-label="More actions"]`)).toBeNull();

    rowData[0] = {
      ...updateRow,
      installedPlugin: installed('vercel', 'marketplace', { version: '2.0.0' }),
      updateAvailable: false,
    };
    plugins.state.busy['vercel:install'] = undefined;
    await settle();

    expect(host.querySelector(`${rowActions} .ui-button`)).toBeNull();
    expect(host.querySelector(`${rowActions} [role="switch"]`)).not.toBeNull();
    expect(host.querySelector(`${rowActions} [aria-label="More actions"]`)).not.toBeNull();
  });

  it('closes an open more-actions menu when installing starts and keeps it closed after settlement', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', { version: '2.0.0' }),
      installedPlugin: installed('vercel', 'marketplace', { version: '1.0.0' }),
      displayName: 'Vercel',
      updateAvailable: true,
    }));
    await mountPanel();

    const addDocumentListener = vi.spyOn(document, 'addEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const addWindowListener = vi.spyOn(window, 'addEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    try {
      const trigger = host.querySelector<HTMLButtonElement>(
        '.plugin-row .plugin-actions [aria-label="More actions"]',
      )!;
      trigger.click();
      await settle();

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelector('.plugin-row .plugin-actions__menu .ui-menu-item')).not.toBeNull();
      const docMouseDown = addDocumentListener.mock.calls.findLast(([type]) => type === 'mousedown')?.[1];
      const docKeyDown = addDocumentListener.mock.calls.findLast(([type]) => type === 'keydown')?.[1];
      const winResize = addWindowListener.mock.calls.findLast(([type]) => type === 'resize')?.[1];
      const winBlur = addWindowListener.mock.calls.findLast(([type]) => type === 'blur')?.[1];
      expect(docMouseDown).toBeDefined();
      expect(docKeyDown).toBeDefined();
      expect(winResize).toBeDefined();
      expect(winBlur).toBeDefined();

      plugins.state.busy['vercel:install'] = true;
      await settle();

      expect(host.querySelector('.plugin-row .plugin-actions [aria-label="More actions"]')).toBeNull();
      expect(host.querySelector('.plugin-actions__menu')).toBeNull();
      expect(removeDocumentListener).toHaveBeenCalledWith('mousedown', docMouseDown);
      expect(removeDocumentListener).toHaveBeenCalledWith('keydown', docKeyDown);
      expect(removeWindowListener).toHaveBeenCalledWith('resize', winResize);
      expect(removeWindowListener).toHaveBeenCalledWith('blur', winBlur);

      plugins.state.busy['vercel:install'] = undefined;
      await settle();

      const restoredTrigger = host.querySelector<HTMLButtonElement>(
        '.plugin-row .plugin-actions [aria-label="More actions"]',
      );
      expect(restoredTrigger).not.toBeNull();
      expect(restoredTrigger!.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('.plugin-actions__menu')).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns to the install button when a first install fails', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      displayName: 'Vercel',
    }));
    await mountPanel();

    plugins.state.busy['vercel:install'] = true;
    await nextTick();
    expect(host.querySelector('.plugin-row .plugin-actions .ui-button')?.textContent).toContain('Installing');
    expect(host.querySelector('.plugin-row .plugin-actions [role="switch"]')).toBeNull();
    expect(host.querySelector('.plugin-row .plugin-actions [aria-label="More actions"]')).toBeNull();

    plugins.state.busy['vercel:install'] = undefined;
    plugins.state.rowErrors['vercel'] = 'download failed';
    await nextTick();

    expect(host.querySelector<HTMLButtonElement>('.plugin-row .plugin-actions .ui-button')?.textContent).toContain('Install');
    expect(host.querySelector<HTMLButtonElement>('.plugin-row .plugin-actions .ui-button')?.disabled).toBe(false);
    expect(host.querySelector('.plugin-row .plugin-status__error')?.textContent).toBe('download failed');
  });

  it('keeps the switch and more actions disabled in place during toggle and remove', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();

    plugins.state.busy['vercel:toggle'] = true;
    await nextTick();
    expect(host.querySelector('.plugin-row .plugin-actions [role="switch"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.plugin-row .plugin-actions [role="switch"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.plugin-row .plugin-actions [aria-label="More actions"]')?.disabled).toBe(true);

    plugins.state.busy['vercel:toggle'] = undefined;
    plugins.state.busy['vercel:remove'] = true;
    await nextTick();
    expect(host.querySelector('.plugin-row .plugin-actions [role="switch"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.plugin-row .plugin-actions [aria-label="More actions"]')?.disabled).toBe(true);
  });

  it('disables installation for a cloud-only row and explains the boundary', async () => {
    rowData.push(row('cloud-only', {
      catalogEntry: entry('cloud-only', 'Cloud only', { platforms: ['cloud'] }),
      displayName: 'Cloud only',
      cloudOnly: true,
    }));
    await mountPanel();

    expect(host.textContent).toContain('Cloud installation isn’t supported yet');
    expect(host.querySelector('.plugin-row .plugin-actions .ui-button')).toBeNull();
  });

  it('keeps the local install action for a cloud plus local row', async () => {
    const localRow = row('cloud-local', {
      catalogEntry: entry('cloud-local', 'Cloud local', { platforms: ['cloud', 'macos'] }),
      displayName: 'Cloud local',
      cloudOnly: false,
    });
    rowData.push(localRow);
    await mountPanel();

    const installButton = host.querySelector<HTMLButtonElement>(
      '.plugin-row .plugin-actions .ui-button',
    )!;
    expect(installButton.textContent).toContain('Install');
    installButton.click();
    expect(plugins.installRow).toHaveBeenCalledWith(localRow, { confirmStopProcesses: expect.any(Function) });
  });

  it('does not offer an update for a cloud-only row with updateAvailable', async () => {
    rowData.push(row('cloud-update', {
      catalogEntry: entry('cloud-update', 'Cloud update', {
        platforms: ['cloud'],
        version: '2.0.0',
        updateAvailable: true,
      }),
      installedPlugin: installed('cloud-update', 'marketplace', { version: '1.0.0' }),
      displayName: 'Cloud update',
      cloudOnly: true,
      updateAvailable: true,
    }));
    await mountPanel();

    expect(host.querySelector('.plugin-row .plugin-actions .ui-button')).toBeNull();
    expect(host.querySelector('.plugin-row .plugin-actions')?.textContent).not.toContain('Update');
  });

  it('focuses the first menu item on open and restores the trigger on Escape', async () => {
    rowData.push(row('installed', {
      catalogEntry: entry('installed', 'Installed'),
      installedPlugin: installed('installed', 'custom'),
      displayName: 'Installed',
    }));
    await mountPanel('zh');

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!;
    trigger.focus();
    trigger.click();
    await settle();
    const item = host.querySelector<HTMLButtonElement>('.plugin-actions__menu .ui-menu-item')!;
    expect(item.textContent).toContain('卸载');
    expect(document.activeElement).toBe(item);

    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(item);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('anchors the browser extension hint to its plugin row', async () => {
    rowData.push(
      row('kimi-browser-extension', {
        catalogEntry: entry('kimi-browser-extension', 'Kimi Browser Extension', {
          capabilityId: 'kimi-webbridge',
        }),
        installedPlugin: installed('kimi-browser-extension', 'marketplace'),
        installId: 'kimi-webbridge',
        capabilityRequired: true,
        capability: {
          id: 'kimi-webbridge',
          pluginId: 'kimi-browser-extension',
          displayName: 'Kimi Browser Extension',
          description: 'Browser automation',
          supported: true,
          state: 'ready',
          steps: [{ id: 'extension', state: 'missing' }],
          install: { running: false },
        },
      }),
      row('cloudbase', { catalogEntry: entry('cloudbase', 'CloudBase') }),
    );
    await mountPanel();
    plugins.state.extensionHint = true;
    await nextTick();

    const browserRow = host.querySelector('[data-plugin-row="kimi-browser-extension"]')!
      .closest('.plugin-row')!;
    const otherRow = host.querySelector('[data-plugin-row="cloudbase"]')!
      .closest('.plugin-row')!;
    const hint = host.querySelector('.pp-ext-hint')!;
    expect(browserRow.contains(hint)).toBe(true);
    expect(otherRow.contains(hint)).toBe(false);
    expect(host.querySelectorAll('.pp-ext-hint')).toHaveLength(1);

    hint.querySelector<HTMLButtonElement>('.pp-ext-close')!.click();
    await nextTick();
    expect(host.querySelector('.pp-ext-hint')).toBeNull();
  });

  it('uses a secondary install button in rows and keeps the primary action in details', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      displayName: 'Vercel',
    }));
    await mountPanel();

    const listButton = host.querySelector<HTMLButtonElement>(
      '.plugin-row .plugin-actions .ui-button',
    )!;
    expect(listButton.classList.contains('ui-button--secondary')).toBe(true);
    expect(listButton.classList.contains('ui-button--xs')).toBe(true);

    clickButton('Vercel');
    await settle();
    const detailsButton = host.querySelector<HTMLButtonElement>(
      '.plugin-details .plugin-actions .ui-button',
    )!;
    expect(detailsButton.classList.contains('ui-button--primary')).toBe(true);
  });

  it('runs install and update actions without a sign-in gate', async () => {
    const installRow = row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      displayName: 'Vercel',
    });
    const updateRow = row('cloudbase', {
      catalogEntry: entry('cloudbase', 'CloudBase', { version: '2.0.0' }),
      installedPlugin: installed('cloudbase', 'marketplace', { version: '1.0.0' }),
      displayName: 'CloudBase',
      updateAvailable: true,
    });
    rowData.push(installRow, updateRow);
    await mountPanel();

    const actions = [
      ...host.querySelectorAll<HTMLButtonElement>('.plugin-row .plugin-actions .ui-button'),
    ];
    expect(actions.map((action) => action.textContent?.trim())).toEqual(['Install', 'Update']);
    expect(host.textContent).not.toContain('Sign in to install');

    for (const [index, action] of actions.entries()) {
      action.click();
      expect(plugins.installRow).toHaveBeenNthCalledWith(index + 1, rowData[index], {
        confirmStopProcesses: expect.any(Function),
      });
    }
  });

  it.each([false, true])('asks before stopping running plugin processes: %s', async (confirmed) => {
    rowData.push(row('kimi-cu-win', {
      catalogEntry: entry('kimi-cu-win', 'Windows Computer Use'),
      displayName: 'Windows Computer Use',
    }));
    await mountPanel();
    const resolved = vi.fn();
    vi.mocked(plugins.installRow).mockImplementation(async (_row, options) => {
      resolved(await options?.confirmStopProcesses?.());
    });
    host.querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!.click();
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('processes are still running');
    expect(resolved).not.toHaveBeenCalled();
    const button = dialog.querySelector<HTMLButtonElement>(
      confirmed ? '.confirm-dialog__confirm' : '.confirm-dialog__cancel',
    )!;
    button.click();
    await settle();
    expect(resolved).toHaveBeenCalledWith(confirmed);
  });

  it('uses update-specific copy when stopping WebBridge processes', async () => {
    rowData.push(row('kimi-browser-extension', {
      installId: 'kimi-webbridge',
      catalogEntry: entry('kimi-browser-extension', 'Kimi Browser Extension', {
        capabilityId: 'kimi-webbridge',
        version: '2.0.35',
      }),
      installedPlugin: installed('kimi-browser-extension', 'marketplace', { version: '2.0.34' }),
      capability: {
        id: 'kimi-webbridge',
        pluginId: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        description: 'Browser control',
        supported: true,
        state: 'ready',
        steps: [],
        install: { running: false },
      },
      capabilityRequired: true,
      displayName: 'Kimi Browser Extension',
      updateAvailable: true,
    }));
    await mountPanel();
    vi.mocked(plugins.installRow).mockImplementation(async (_row, options) => {
      await options?.confirmStopProcesses?.();
    });

    host.querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!.click();
    await settle();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Stop processes and update');
    expect(dialog.textContent).toContain('Kimi Browser Extension processes are still running');
    expect(dialog.textContent).toContain('ongoing browser tasks may be interrupted');
    expect(dialog.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.textContent).toBe('Stop and update');
  });

  it('uses installation copy when repairing WebBridge wiring without an update', async () => {
    rowData.push(row('kimi-browser-extension', {
      installId: 'kimi-webbridge',
      catalogEntry: entry('kimi-browser-extension', 'Kimi Browser Extension', {
        capabilityId: 'kimi-webbridge',
      }),
      capability: {
        id: 'kimi-webbridge',
        pluginId: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        description: 'Browser control',
        supported: true,
        state: 'ready',
        steps: [],
        install: { running: false },
      },
      capabilityRequired: true,
      displayName: 'Kimi Browser Extension',
    }));
    await mountPanel();
    vi.mocked(plugins.installRow).mockImplementation(async (_row, options) => {
      await options?.confirmStopProcesses?.();
    });

    host.querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!.click();
    await settle();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Stop processes and continue installation');
    expect(dialog.textContent).not.toContain('Stop processes and update');
    expect(dialog.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.textContent).toBe('Stop processes and continue');
  });

  it('starts OAuth after a successful first install with a different catalog ID', async () => {
    rowData.push(row('vercel-catalog', {
      catalogEntry: entry('vercel-catalog', 'Vercel'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    vi.mocked(plugins.installRow).mockImplementation(async () => {
      plugins.state.installed.push(installed('vercel-package', 'marketplace', {
        catalogId: 'vercel-catalog',
      }));
    });

    host.querySelector<HTMLButtonElement>(
      '[data-plugin-row="vercel-catalog"]',
    )!.closest('.plugin-row')!.querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!.click();
    await settle();

    expect(authorization.authorizePlugin).toHaveBeenCalledWith('vercel-package');
  });

  it('does not start OAuth for failed installs, updates, or capability installs', async () => {
    rowData.push(
      row('failed', { catalogEntry: entry('failed', 'Failed'), displayName: 'Failed' }),
      row('update', {
        catalogEntry: entry('update', 'Update', { version: '2.0.0' }),
        installedPlugin: installed('update', 'marketplace', { version: '1.0.0' }),
        displayName: 'Update',
        updateAvailable: true,
      }),
      row('capability', {
        catalogEntry: entry('capability', 'Capability', { capabilityId: 'capability' }),
        displayName: 'Capability',
      }),
    );
    await mountPanel();
    vi.mocked(plugins.installRow).mockImplementation(async (item) => {
      if (item.id === 'failed') plugins.state.rowErrors.failed = 'install failed';
      if (item.id === 'capability') plugins.state.installed.push(installed('capability', 'marketplace'));
    });
    const clickAction = (id: string): void => {
      host.querySelector<HTMLButtonElement>(`[data-plugin-row="${id}"]`)!
        .closest('.plugin-row')!
        .querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!
        .click();
    };

    clickAction('failed');
    await settle();
    clickAction('update');
    await settle();
    clickAction('capability');
    await settle();

    expect(authorization.authorizePlugin).not.toHaveBeenCalled();
  });

  it('starts authorization from an OAuth MCP row without opening on details mount', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = { status: 'oauth-required', phase: 'idle' };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();

    expect(authorization.refresh).toHaveBeenCalledWith('vercel');
    expect(authorization.authorize).not.toHaveBeenCalled();
    const button = host.querySelector<HTMLButtonElement>('.plugin-capabilities__actions button');
    expect(button?.textContent?.trim()).toBe('Connect');
    button!.click();
    expect(authorization.authorize).toHaveBeenCalledWith({
      pluginId: 'vercel',
      serverName: 'vercel',
      runtimeName: 'plugin-vercel:vercel',
    });
  });

  it('renders MCP authorization controls and errors', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-required',
      phase: 'waiting',
      flowId: 'flow-1',
      authorizationUrl: 'https://auth.example.test/authorize',
      openBlocked: true,
    };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();

    const details = host.querySelector('.plugin-details')!;
    expect(details.textContent).toContain('Waiting for authorization…');
    expect(details.querySelector('.plugin-capabilities__authorization-note')).toBeNull();
    expect(details.textContent).not.toContain('The browser did not open the page');
    const authorizationLink = details.querySelector<HTMLAnchorElement>(
      '.plugin-capabilities__authorization-link',
    )!;
    expect(authorizationLink.textContent).toContain('Open authorization link');
    expect(authorizationLink.href).toBe('https://auth.example.test/authorize');
    clickButton('Disconnect');
    expect(authorization.cancel).toHaveBeenCalledWith('plugin-vercel:vercel');

    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-required',
      phase: 'idle',
      cancelled: true,
    };
    await nextTick();
    expect(details.textContent).not.toContain('Authorization cancelled');
    expect(details.querySelector('.plugin-capabilities__actions button')?.textContent).toBe('Connect');

    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-required',
      phase: 'idle',
      error: 'failed to start OAuth flow: software statement is invalid',
    };
    await nextTick();
    const authorizationError = details.querySelector('.plugin-capabilities__authorization-error');
    expect(authorizationError?.textContent).toContain('Authorization failed. Please try again later');
    expect(await hoverTooltipText(authorizationError)).toContain('software statement is invalid');
    expect(details.querySelector('.plugin-capabilities__actions button')?.textContent).toBe('Retry authorization');

    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-authorized',
      phase: 'idle',
    };
    await nextTick();
    expect(details.querySelector('.plugin-capabilities__identity')?.textContent).toContain('Connected');
    expect(details.textContent).not.toContain('OAuth completed. MCP connected.');
    expect(details.querySelector('.plugin-capabilities__authorization-note')).toBeNull();
    expect(details.querySelectorAll('.plugin-capabilities__actions button')).toHaveLength(1);

    clickButton('Disconnect');
    await nextTick();
    let confirmation = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Disconnect"]',
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation?.textContent).toContain('vercel');
    expect(confirmation?.textContent).toContain('removes the OAuth credentials saved on this device');
    confirmation!.querySelector<HTMLButtonElement>('.confirm-dialog__cancel')!.click();
    await nextTick();
    expect(authorization.reset).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"][aria-label="Disconnect"]')).toBeNull();

    clickButton('Disconnect');
    await nextTick();
    confirmation = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Disconnect"]',
    );
    confirmation!.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.click();
    await nextTick();
    expect(authorization.reset).toHaveBeenCalledWith({
      pluginId: 'vercel',
      serverName: 'vercel',
      runtimeName: 'plugin-vercel:vercel',
    });
    expect(document.body.querySelector('[role="dialog"][aria-label="Disconnect"]')).toBeNull();

    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-authorized',
      phase: 'resetting',
    };
    await nextTick();
    expect(details.textContent).toContain('Cancelling authorization…');
    expect(details.querySelectorAll('.plugin-capabilities__actions button')).toHaveLength(0);
  });

  it('retries loading authorization status after a refresh failure', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.refresh.mockRejectedValueOnce(new Error('status unavailable'));
    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();
    expect(host.querySelector('.plugin-capabilities__error')?.textContent).toContain('status unavailable');

    authorization.refresh.mockResolvedValue(undefined);
    clickButton('Retry loading authorization status');
    await settle();

    expect(authorization.refresh).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.plugin-capabilities__error')).toBeNull();
  });

  it('uses the actual custom install origin for installed details', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'custom'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    buttons().find((button) => button.textContent?.includes('My plugins'))!.click();
    await nextTick();
    clickButton('Vercel');
    await settle();

    const details = host.querySelector('.plugin-details')!;
    expect(details.textContent).toContain('Custom');
    expect(details.textContent).not.toContain('Official');
    expect(details.querySelector('.plugin-details__badge--official')).toBeNull();
  });

  it('keeps the marketplace origin for installed details without a catalog entry', async () => {
    rowData.push(row('vercel', {
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
      official: false,
    }));
    await mountPanel();
    buttons().find((button) => button.textContent?.includes('My plugins'))!.click();
    await nextTick();
    clickButton('Vercel');
    await settle();

    const details = host.querySelector('.plugin-details')!;
    expect(details.textContent).toContain('Plugin marketplace');
    expect(details.textContent).not.toContain('Custom');
  });

  it('reloads capabilities and OAuth state when the installed version changes', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', { version: '2.0.0' }),
      installedPlugin: installed('vercel', 'marketplace', { version: '1.0.0' }),
      displayName: 'Vercel',
    }));
    await mountPanel();
    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();
    expect(plugins.loadPluginCapabilities).toHaveBeenCalledTimes(1);
    expect(authorization.refresh).toHaveBeenCalledTimes(1);

    rowData[0]!.installedPlugin = installed('vercel', 'marketplace', { version: '2.0.0' });

    await vi.waitFor(() => {
      expect(plugins.loadPluginCapabilities).toHaveBeenCalledTimes(2);
      expect(authorization.refresh).toHaveBeenCalledTimes(2);
    });
  });

  it('hides the tagline when a plugin has no short description', async () => {
    rowData.push(row('custom', {
      installedPlugin: installed('custom', 'custom'),
      displayName: 'Custom',
    }));
    await mountPanel();

    clickButton('My plugins');
    await settle();
    clickButton('Custom');
    await settle();

    expect(host.querySelector('.plugin-details__tagline')).toBeNull();
  });

  it('shows a localized authorization failure message', async () => {
    rowData.push(row('jira-composio', {
      catalogEntry: entry('jira-composio', 'Jira'),
      installedPlugin: installed('jira-composio', 'marketplace'),
      displayName: 'Jira',
    }));
    await mountPanel('zh');
    authorization.states['plugin-jira-composio:jira-composio'] = {
      status: 'oauth-required',
      phase: 'idle',
      error: 'invalid_software_statement',
    };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'jira-composio',
        runtimeName: 'plugin-jira-composio:jira-composio',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('我的插件');
    await nextTick();
    clickButton('Jira');
    await settle();

    const error = host.querySelector('.plugin-capabilities__authorization-error');
    expect(error?.textContent?.trim()).toBe('授权失败，请稍后重试');
    expect(await hoverTooltipText(error)).toBe('invalid_software_statement');
  });

  it('shows reset failures and keeps the authorized badge control', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      installedPlugin: installed('vercel', 'marketplace'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = {
      status: 'oauth-authorized',
      phase: 'idle',
      error: 'reset failed',
    };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('My plugins');
    await nextTick();
    clickButton('Vercel');
    await settle();

    const resetError = host.querySelector('.plugin-capabilities__authorization-error');
    expect(resetError?.textContent).toContain('Authorization failed. Please try again later');
    expect(await hoverTooltipText(resetError)).toBe('reset failed');
    expect(host.querySelector('.plugin-capabilities__actions')).not.toBeNull();
  });

  it('does not show OAuth actions in an uninstalled marketplace preview', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel'),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = { status: 'oauth-required', phase: 'idle' };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('Vercel');
    await settle();

    expect(host.querySelector('.plugin-capabilities__actions')).toBeNull();
    expect(authorization.refresh).not.toHaveBeenCalled();
  });

  it('does not mix installed OAuth state into a marketplace capability preview', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', { version: '2.0.0' }),
      installedPlugin: installed('vercel', 'marketplace', { version: '1.0.0' }),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = { status: 'oauth-authorized', phase: 'idle' };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('Vercel');
    await settle();

    expect(host.querySelector('.plugin-capabilities__actions')).toBeNull();
    expect(host.querySelector('.plugin-capabilities__identity')?.textContent).not.toContain('Connected');
    expect(authorization.refresh).not.toHaveBeenCalled();
  });

  it('allows OAuth in marketplace details when the installed version matches the catalog', async () => {
    rowData.push(row('vercel', {
      catalogEntry: entry('vercel', 'Vercel', { version: '1.0.0' }),
      installedPlugin: installed('vercel', 'marketplace', { version: '1.0.0' }),
      displayName: 'Vercel',
    }));
    await mountPanel();
    authorization.states['plugin-vercel:vercel'] = { status: 'oauth-required', phase: 'idle' };
    vi.mocked(plugins.loadPluginCapabilities).mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: 'vercel',
        runtimeName: 'plugin-vercel:vercel',
        enabled: true,
        transport: 'http',
      }],
    });

    clickButton('Vercel');
    await settle();

    const button = host.querySelector<HTMLButtonElement>('.plugin-capabilities__actions button');
    expect(button?.textContent).toBe('Connect');
    button!.click();
    expect(authorization.authorize).toHaveBeenCalledWith({
      pluginId: 'vercel',
      serverName: 'vercel',
      runtimeName: 'plugin-vercel:vercel',
    });
  });

});
