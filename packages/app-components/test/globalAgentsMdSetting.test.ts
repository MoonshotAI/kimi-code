// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';

const fakes = vi.hoisted(() => ({
  getGlobalAgentsMd: vi.fn(),
  writeGlobalAgentsMd: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  useKimiWebClient: () => ({
    getGlobalAgentsMd: fakes.getGlobalAgentsMd,
    writeGlobalAgentsMd: fakes.writeGlobalAgentsMd,
    notify: fakes.notify,
  }),
}));

vi.mock('@moonshot-ai/app-client/composables', () => ({
  useConfirmDialog: () => ({ confirm: fakes.confirm }),
}));

import GlobalAgentsMdSetting from '../src/settings/GlobalAgentsMdSetting.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
  fakes.getGlobalAgentsMd.mockReset();
  fakes.writeGlobalAgentsMd.mockReset();
  fakes.notify.mockReset();
  fakes.confirm.mockReset();
  fakes.getGlobalAgentsMd.mockResolvedValue({
    path: '/home/.kimi-code/AGENTS.md',
    content: '# Existing instructions\n',
    exists: true,
  });
  fakes.writeGlobalAgentsMd.mockImplementation(async (content: string) => ({
    path: '/home/.kimi-code/AGENTS.md',
    content,
    exists: true,
  }));
  fakes.confirm.mockResolvedValue(true);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountSetting() {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(GlobalAgentsMdSetting) });
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
  const root = host;
  return {
    root,
    row: () => root.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="globalAgentsMd"]')!,
    page: () => root.querySelector<HTMLElement>('.settings-subpage'),
    editor: () => root.querySelector<HTMLTextAreaElement>('.global-agents-md-editor'),
    save: () => root.querySelector<HTMLButtonElement>('.global-agents-md-footer button')!,
    back: () => root.querySelector<HTMLButtonElement>('.settings-subpage-back')!,
  };
}

async function openEditor(context: Awaited<ReturnType<typeof mountSetting>>): Promise<void> {
  context.row().click();
  await flush();
}

function edit(context: Awaited<ReturnType<typeof mountSetting>>, value: string): void {
  const editor = context.editor()!;
  editor.value = value;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('global AGENTS.md setting', () => {
  it('loads the current file when opened and saves exact edits', async () => {
    const context = await mountSetting();
    expect(fakes.getGlobalAgentsMd).not.toHaveBeenCalled();

    await openEditor(context);

    expect(fakes.getGlobalAgentsMd).toHaveBeenCalledOnce();
    expect(context.editor()?.value).toBe('# Existing instructions\n');
    expect(context.page()?.textContent).toContain('/home/.kimi-code/AGENTS.md');
    expect(context.save().disabled).toBe(true);

    edit(context, '  Updated instructions\n\n');
    await flush();
    expect(context.save().disabled).toBe(false);
    context.save().click();
    await flush();

    expect(fakes.writeGlobalAgentsMd).toHaveBeenCalledWith('  Updated instructions\n\n');
    expect(context.editor()?.value).toBe('  Updated instructions\n\n');
    expect(context.save().disabled).toBe(true);
    expect(fakes.notify).toHaveBeenCalledWith({ severity: 'success', title: 'Saved' });
    expect(context.page()?.textContent).not.toContain('Saved');
  });

  it('offers to create a missing file on first save', async () => {
    fakes.getGlobalAgentsMd.mockResolvedValue({
      path: '/home/.kimi-code/AGENTS.md',
      content: '',
      exists: false,
    });
    const context = await mountSetting();
    await openEditor(context);

    expect(context.editor()?.value).toBe('');
    expect(context.page()?.textContent).toContain('The file doesn’t exist yet and will be created when you save');

    edit(context, '# New file\n');
    await flush();
    context.save().click();
    await flush();

    expect(fakes.writeGlobalAgentsMd).toHaveBeenCalledWith('# New file\n');
    expect(fakes.notify).toHaveBeenCalledWith({ severity: 'success', title: 'Saved' });
    expect(context.page()?.textContent).not.toContain('Saved');
  });

  it('keeps the editor available after a load failure and retries', async () => {
    fakes.getGlobalAgentsMd.mockRejectedValueOnce(new Error('Permission denied'));
    const context = await mountSetting();
    await openEditor(context);

    expect(context.page()?.textContent).toContain('Couldn’t load AGENTS.md. Try again');
    expect(context.page()?.textContent).toContain('Permission denied');
    expect(context.editor()).toBeNull();

    const retry = Array.from(context.page()!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Retry')!;
    retry.click();
    await flush();

    expect(fakes.getGlobalAgentsMd).toHaveBeenCalledTimes(2);
    expect(context.editor()?.value).toBe('# Existing instructions\n');
  });

  it('keeps the editor enabled and preserves edits made while saving', async () => {
    let resolveWrite: ((value: { path: string; content: string; exists: boolean }) => void) | undefined;
    fakes.writeGlobalAgentsMd.mockImplementation(() => new Promise((resolve) => {
      resolveWrite = resolve;
    }));
    const context = await mountSetting();
    await openEditor(context);
    edit(context, '# First save\n');
    await flush();

    context.save().click();
    await flush();
    expect(context.editor()?.disabled).toBe(false);
    expect(context.save().classList.contains('is-loading')).toBe(false);
    expect(context.save().textContent).toBe('Save');

    edit(context, '# Edited while saving\n');
    resolveWrite?.({
      path: '/home/.kimi-code/AGENTS.md',
      content: '# First save\n',
      exists: true,
    });
    await flush();

    expect(context.editor()?.value).toBe('# Edited while saving\n');
    expect(context.save().disabled).toBe(false);
    expect(fakes.notify).not.toHaveBeenCalled();
    expect(context.page()?.textContent).toContain('Unsaved changes');
  });

  it('confirms before discarding unsaved edits', async () => {
    fakes.confirm.mockResolvedValueOnce(false);
    const context = await mountSetting();
    await openEditor(context);
    edit(context, '# Unsaved\n');
    await flush();

    context.back().click();
    await flush();

    expect(fakes.confirm).toHaveBeenCalledOnce();
    expect(context.page()).not.toBeNull();
    expect(context.editor()?.value).toBe('# Unsaved\n');

    context.back().click();
    await flush();

    expect(fakes.confirm).toHaveBeenCalledTimes(2);
    expect(context.page()).toBeNull();
    expect(context.row()).not.toBeNull();
  });
});
