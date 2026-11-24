// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppToolsConfig } from '@moonshot-ai/app-core/api';

const fakes = vi.hoisted(() => ({
  listToolCatalog: vi.fn(),
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  back: vi.fn(),
  open: vi.fn(),
  config: null as null | { value: { tools?: AppToolsConfig } | null },
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  getKimiWebApi: () => ({ listToolCatalog: fakes.listToolCatalog }),
  toast: fakes.toast,
  t: (key: string) => key,
}));

vi.mock('@moonshot-ai/app-client/stores', async () => {
  const vue = await import('vue');
  fakes.config = vue.ref<{ tools?: AppToolsConfig } | null>(null);
  return {
    configStore: () => ({
      config: fakes.config!.value,
      updateConfig: fakes.updateConfig,
      loadConfig: fakes.loadConfig,
    }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', () => ({
  useConfirmDialog: () => ({ confirm: fakes.confirm }),
}));

import DefaultToolsPanel from '../src/settings/DefaultToolsPanel.vue';
import DefaultToolsRow from '../src/settings/DefaultToolsRow.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  fakes.config!.value = {
    tools: { enabled: ['Read'], disabled: ['Bash', 'mcp__example__*'] },
  };
  fakes.listToolCatalog.mockReset().mockResolvedValue([
    { name: 'Bash', source: 'builtin' },
    { name: 'Read', source: 'builtin' },
  ]);
  fakes.loadConfig.mockReset().mockResolvedValue('committed');
  fakes.updateConfig.mockReset().mockResolvedValue(true);
  fakes.confirm.mockReset().mockResolvedValue(true);
  fakes.toast.mockReset();
  fakes.back.mockReset();
  fakes.open.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel(): Promise<{ confirmDiscard: () => Promise<boolean> }> {
  host = document.createElement('div');
  host.className = 'settings-dialog';
  document.body.append(host);
  let panel!: { confirmDiscard: () => Promise<boolean> };
  app = createApp({
    setup: () => () => h(DefaultToolsPanel, {
      ref: (value) => { panel = value as { confirmDiscard: () => Promise<boolean> }; },
      onBack: fakes.back,
    }),
  });
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
  return panel;
}

function switches(): HTMLButtonElement[] {
  return [...(host?.querySelectorAll<HTMLButtonElement>('[role="switch"]') ?? [])];
}

function switchNamed(label: string): HTMLButtonElement {
  const item = switches().find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!item) throw new Error(`Missing switch ${label}`);
  return item;
}

function button(text: string): HTMLButtonElement | undefined {
  return [...(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === text);
}

describe('DefaultToolsPanel', () => {
  it('loads a grouped catalog without search, bulk actions, or enabled counts', async () => {
    await mountPanel();

    expect(fakes.listToolCatalog).toHaveBeenCalledOnce();
    expect(switches().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(host?.querySelector('input[type="search"]')).toBeNull();
    expect(host?.textContent).not.toContain('Enable all');
    expect(host?.textContent).not.toContain('Disable all');
    expect(host?.textContent).not.toContain('2 enabled');
    expect(host?.textContent).toContain('Changes apply immediately to current and new sessions');
    expect(button('Save')?.disabled).toBe(true);
  });

  it('edits a draft and only writes config when Save is clicked', async () => {
    await mountPanel();
    switchNamed('tools.label.bash').click();
    await flush();

    expect(fakes.updateConfig).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('Unsaved changes');
    expect(button('Save')?.disabled).toBe(false);
    button('Save')?.click();
    await flush();

    expect(fakes.updateConfig).toHaveBeenCalledWith({
      tools: { enabled: ['Bash', 'Read'], disabled: ['mcp__example__*'] },
    });
    expect(fakes.toast).toHaveBeenCalledWith({ layout: 'bar', mode: 'replace', variant: 'success', title: 'Tool settings saved' });
    expect(host?.textContent).not.toContain('Unsaved changes');
    expect(button('Save')?.disabled).toBe(true);
  });

  it('keeps the draft and shows feedback when saving fails', async () => {
    fakes.updateConfig.mockResolvedValue(false);
    await mountPanel();
    switchNamed('tools.label.bash').click();
    await flush();
    button('Save')?.click();
    await flush();

    expect(host?.textContent).toContain('Couldn\'t save. Try again');
    expect(host?.textContent).toContain('Unsaved changes');
    expect(switchNamed('tools.label.bash').getAttribute('aria-checked')).toBe('true');
    expect(button('Save')?.disabled).toBe(false);
  });

  it('confirms before discarding changes on back', async () => {
    await mountPanel();
    switchNamed('tools.label.bash').click();
    await flush();
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();

    expect(fakes.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Discard unsaved changes',
      message: 'Your changes won’t be saved',
      confirmLabel: 'Discard changes',
    }));
    expect(fakes.back).toHaveBeenCalledOnce();
  });

  it('stays on the page when discarding is cancelled', async () => {
    fakes.confirm.mockResolvedValue(false);
    await mountPanel();
    switchNamed('tools.label.bash').click();
    await flush();
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();

    expect(fakes.back).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('Unsaved changes');
    expect(switchNamed('tools.label.bash').getAttribute('aria-checked')).toBe('true');
  });

  it('retries a failed catalog load', async () => {
    fakes.listToolCatalog
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ name: 'Read', source: 'builtin' }]);
    await mountPanel();
    expect(host?.textContent).toContain('Could not load the tool list');

    button('Retry')?.click();
    await flush();
    expect(fakes.listToolCatalog).toHaveBeenCalledTimes(2);
    expect(switches()).toHaveLength(1);
  });

  it('blocks editing while config is unavailable and preserves existing denials after retry', async () => {
    fakes.config!.value = null;
    fakes.loadConfig
      .mockResolvedValueOnce('failed')
      .mockImplementationOnce(async () => {
        fakes.config!.value = { tools: { disabled: ['Bash'] } };
        return 'committed';
      });
    await mountPanel();

    expect(fakes.loadConfig).toHaveBeenCalledOnce();
    expect(switches()).toHaveLength(0);
    expect(host?.textContent).toContain('Could not load the tool list');
    expect(button('Save')?.disabled).toBe(true);

    button('Retry')?.click();
    await flush();
    expect(fakes.loadConfig).toHaveBeenCalledTimes(2);
    expect(switchNamed('tools.label.bash').getAttribute('aria-checked')).toBe('false');

    switchNamed('tools.label.read').click();
    await flush();
    button('Save')?.click();
    await flush();
    expect(fakes.updateConfig).toHaveBeenCalledWith({
      tools: { enabled: undefined, disabled: ['Bash', 'Read'] },
    });
  });

  it('initializes the draft when a config without a tools section loads after mount', async () => {
    fakes.config!.value = null;
    fakes.loadConfig.mockImplementationOnce(async () => {
      fakes.config!.value = {};
      return 'committed';
    });
    await mountPanel();

    expect(switches()).toHaveLength(2);
    expect(switchNamed('tools.label.bash').getAttribute('aria-checked')).toBe('true');
  });

  it('refuses to discard while a save is in flight', async () => {
    let resolveSave!: (saved: boolean) => void;
    fakes.updateConfig.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    }));
    const panel = await mountPanel();
    switchNamed('tools.label.bash').click();
    await flush();
    button('Save')?.click();
    await flush();

    await expect(panel.confirmDiscard()).resolves.toBe(false);
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();
    expect(fakes.confirm).not.toHaveBeenCalled();
    expect(fakes.back).not.toHaveBeenCalled();

    resolveSave(true);
    await flush();
    await expect(panel.confirmDiscard()).resolves.toBe(true);
  });
});

describe('DefaultToolsRow', () => {
  it('opens the tools subpage without an entry icon or enabled count', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ setup: () => () => h(DefaultToolsRow, { onOpen: fakes.open }) });
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await flush();

    const entry = host.querySelector<HTMLButtonElement>('.dt-entry')!;
    expect(entry.textContent).toContain('Built-in tools');
    expect(entry.textContent).toContain('Choose which built-in tools are available in current and new sessions');
    expect(entry.querySelectorAll('svg')).toHaveLength(1);
    expect(entry.querySelector('svg')?.getAttribute('data-icon')).toBe('chevron-right');
    entry.click();
    expect(fakes.open).toHaveBeenCalledWith(entry);
  });
});
