// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppHost, AppHostDefinition, AppHostTestResult, AppSshConfigHosts } from '@moonshot-ai/app-core/api';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { hostsStore, type HostAccount } from '@moonshot-ai/app-client/stores';
import HostsPanel from '../src/settings/HostsPanel.vue';

let app: App | undefined;
let host: HTMLDivElement;

const NEW_ID = 'host-a1b2c3d4';

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('a1b2c3d4-0000-4000-8000-000000000000');
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  useConfirmDialog().settle(false);
  const store = hostsStore();
  store.byId = {};
  store.loaded = false;
  store.connecting = {};
  store.providerCopies = {};
  store.accounts = {};
  store.loginHostId = null;
  store.focusHostId = null;
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function sshHost(id: string, extra: Partial<AppHost> = {}): AppHost {
  return { id, host: id, status: 'pending', ...extra };
}

function failedTest(connectError: string, connectFailure?: AppHostTestResult['connectFailure']): AppHostTestResult {
  return { connected: false, connectError, connectFailure };
}

function mountPanel(options: {
  hosts?: AppHost[];
  test?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
  loadSshHosts?: () => Promise<AppSshConfigHosts>;
  openSshConfig?: (path: string) => void;
  connect?: (hostId: string) => Promise<unknown>;
  connecting?: Record<string, boolean>;
  pickIdentityFile?: (defaultPath?: string) => Promise<string | undefined>;
  createProject?: (hostId: string) => void;
  copyProviders?: (hostId: string) => Promise<void>;
  accounts?: Record<string, HostAccount>;
  loadAccount?: (hostId: string) => Promise<void>;
  signIn?: (hostId: string) => void;
  signOut?: (hostId: string) => Promise<void>;
} = {}) {
  const store = hostsStore();
  store.byId = Object.fromEntries((options.hosts ?? []).map((row) => [row.id, row]));
  store.loaded = true;
  store.connecting = options.connecting ?? {};
  store.providerCopies = {};
  store.accounts = options.accounts ?? {};

  const test = options.test ?? vi.fn(async (): Promise<AppHostTestResult> => ({ connected: true }));
  const save = options.save ?? vi.fn(async (hostId: string, definition: AppHostDefinition) => {
    const existing = store.byId[hostId];
    store.byId = {
      ...store.byId,
      [hostId]: existing === undefined ? { id: hostId, status: 'pending', ...definition } : { ...existing, ...definition },
    };
  });
  const remove = vi.fn(async (hostId: string) => {
    const next = { ...store.byId };
    delete next[hostId];
    store.byId = next;
  });
  const connect = vi.fn(options.connect ?? (async () => undefined));
  const copyProviders = vi.fn(options.copyProviders ?? (async () => undefined));
  const loadAccount = vi.fn(options.loadAccount ?? (async () => undefined));
  const signIn = vi.fn(options.signIn ?? (() => undefined));
  const signOut = vi.fn(options.signOut ?? (async () => undefined));

  vi.spyOn(store, 'load').mockImplementation(async () => store.hosts);
  vi.spyOn(store, 'loadSshConfig').mockImplementation(
    options.loadSshHosts ?? (async () => ({ configPath: '', exists: false, hosts: [] })),
  );
  vi.spyOn(store, 'test').mockImplementation((definition, signal) => test(definition, signal));
  vi.spyOn(store, 'save').mockImplementation(save);
  vi.spyOn(store, 'remove').mockImplementation(remove);
  vi.spyOn(store, 'connect').mockImplementation(connect as never);
  vi.spyOn(store, 'copyProviders').mockImplementation(copyProviders);
  vi.spyOn(store, 'loadAccount').mockImplementation(loadAccount);
  vi.spyOn(store, 'openLogin').mockImplementation(signIn);
  vi.spyOn(store, 'signOut').mockImplementation(signOut);

  app = createApp({
    render: () => h(HostsPanel, {
      openSshConfig: options.openSshConfig,
      pickIdentityFile: options.pickIdentityFile,
      createProject: options.createProject,
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return { store, test, save, remove, connect, copyProviders, loadAccount, signIn, signOut };
}

async function fillForm(id: string, target: string, identityFile?: string): Promise<void> {
  const inputs = host.querySelectorAll<HTMLInputElement>('.re-page .ui-input');
  const values = identityFile === undefined ? [id, target] : [id, target, identityFile];
  for (const [index, value] of values.entries()) {
    inputs[index]!.value = value;
    inputs[index]!.dispatchEvent(new Event('input'));
  }
  await nextTick();
}

function saveButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.re-foot .re-save')!;
}

function addButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.re-head .ui-button')!;
}

async function openRowMenu(index = 0): Promise<void> {
  host.querySelectorAll<HTMLButtonElement>('.re-row-more')[index]!.click();
  await vi.waitFor(() => expect(host.querySelector('.re-row-menu')).not.toBeNull());
}

async function expandFailure(index = 0): Promise<void> {
  host.querySelectorAll<HTMLButtonElement>('.re-row-details')[index]!.click();
  await nextTick();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await nextTick();
}

async function openDraft(name = 'devbox', target = 'dev@example.test'): Promise<void> {
  await flush();
  addButton().click();
  await nextTick();
  await fillForm(name, target);
}

async function openRowEditor(index = 0): Promise<void> {
  await flush();
  await openRowMenu(index);
  host.querySelector<HTMLButtonElement>('.re-row-menu .re-menu-edit')!.click();
  await nextTick();
}

describe('HostsPanel', () => {
  it('tests a new host before saving it and connects right after without copying providers', async () => {
    const { test, save, connect, copyProviders } = mountPanel();
    await flush();
    expect(host.querySelector('.re-empty')).not.toBeNull();
    expect(host.querySelector('.re-hosts')).toBeNull();
    addButton().click();
    await nextTick();
    expect(host.querySelectorAll('.re-page .ui-input')).toHaveLength(3);
    await fillForm('devbox', 'dev@example.test', '~/.ssh/devbox_ed25519');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await flush();

    expect(test).toHaveBeenCalledOnce();
    expect(test.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(save).toHaveBeenCalledWith(NEW_ID, { name: 'devbox', host: 'dev@example.test', identityFile: '~/.ssh/devbox_ed25519' });
    expect(copyProviders).not.toHaveBeenCalled();
    expect(host.querySelector('.re-page')).toBeNull();
    expect(host.querySelector('.re-row-name')?.textContent).toContain('devbox');
    expect(host.querySelector('.re-row-detail')?.textContent).toContain('dev@example.test');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith(NEW_ID));
  });

  it('saves a host:port target as an ssh:// address', async () => {
    const { test, save } = mountPanel();
    await openDraft('devbox', 'dev@127.0.0.1:2222');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    expect(test).toHaveBeenCalledWith(expect.objectContaining({ host: 'ssh://dev@127.0.0.1:2222' }), expect.any(AbortSignal));
    expect(save).toHaveBeenCalledWith(NEW_ID, expect.objectContaining({ host: 'ssh://dev@127.0.0.1:2222' }));
  });

  it('keeps the draft and does not save when the test throws', async () => {
    const test = vi.fn(async () => { throw new Error('SSH handshake failed'); });
    const { save } = mountPanel({ test });
    await openDraft('devbox', 'bad.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(test).toHaveBeenCalledOnce());
    await flush();

    expect(save).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.re-page .ui-input')?.value).toBe('devbox');
    expect(host.querySelector('.re-page [role="alert"]')?.textContent).toContain('SSH handshake failed');
  });

  it('names the outdated remote version and shows the raw error with the hint', async () => {
    const test = vi.fn(async (): Promise<AppHostTestResult> => ({
      connected: false,
      remoteVersion: '0.40.0',
      connectError: "error: unknown option '--probe'",
      connectFailure: 'executor_outdated',
    }));
    mountPanel({ test });
    await openDraft();
    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-reason')).not.toBeNull());

    expect(host.querySelector('.etr-reason')?.textContent).toContain('0.40.0');
    expect(host.querySelector('.etr-hint')?.textContent).toContain('Kimi Code CLI');
    expect(host.querySelector('.etr-detail-toggle')).toBeNull();
    expect(host.querySelector('.etr-detail')?.textContent).toContain("unknown option '--probe'");
    expect(host.querySelector('.etr-step')).toBeNull();
    expect(host.querySelector('.etr-label')).toBeNull();
  });

  it('copies the update command from an expanded outdated host', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountPanel({
      hosts: [sshHost('devbox', { status: 'disconnected', connectError: 'raw', connectFailure: 'executor_outdated' })],
    });
    await flush();
    host.querySelector<HTMLElement>('.re-row-lead')!.click();
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>('.etr-update-command')!;
    expect(button.parentElement).toBe(host.querySelector('.etr-solution'));
    expect(button.previousElementSibling?.classList.contains('etr-hint')).toBe(true);
    expect(button.textContent).toContain('Copy update command');
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('kimi upgrade'));
    await vi.waitFor(() => expect(button.textContent).toContain('Copied'));
    expect(host.querySelector('.etr-install-command')).toBeNull();
  });

  it('copies the install command from a failed connection test', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const test = vi.fn(async () => failedTest('kimi: not found', 'executor_not_found'));
    mountPanel({ test });
    await openDraft();

    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-install-command')).not.toBeNull());
    const button = host.querySelector<HTMLButtonElement>('.etr-install-command')!;
    expect(button.parentElement).toBe(host.querySelector('.etr-solution'));
    expect(button.previousElementSibling?.classList.contains('etr-hint')).toBe(true);
    expect(host.querySelector('.etr-update-command')).toBeNull();
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'));
    await vi.waitFor(() => expect(button.textContent).toContain('Copied'));
  });

  it.each([
    'executor_outdated',
    'authentication_failed',
    'remote_busy',
  ] as const)('offers reason, hint, reconnect, and edit for %s when expanded', async (failure) => {
    const { connect } = mountPanel({
      hosts: [sshHost('devbox', { status: 'disconnected', connectError: 'raw', connectFailure: failure })],
    });
    await flush();

    expect(host.querySelector('.re-row-details-text')).not.toBeNull();
    expect(host.querySelector('.re-row-action')).toBeNull();
    host.querySelector<HTMLElement>('.re-row-lead')!.click();
    await nextTick();
    expect(host.querySelector('.re-page')).toBeNull();
    expect(host.querySelector('.re-row-failure .etr-reason')).toBeNull();
    expect(host.querySelector('.re-row-details-text')?.textContent).toBeTruthy();
    expect(host.querySelector('.re-row-failure .etr-hint')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.re-row-failure .re-row-reconnect')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('devbox'));
    host.querySelector<HTMLButtonElement>('.re-row-failure .re-row-edit')!.click();
    await nextTick();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('devbox');
  });

  it('renames a host without testing it, and omits the name when an unnamed host is unchanged', async () => {
    const { save, test } = mountPanel({
      hosts: [sshHost('devbox', { host: 'old.example.test', remoteBin: '/opt/kimi' }), sshHost('other')],
    });
    await openRowEditor();
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![1].name).toBeUndefined();

    await openRowEditor();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('devbox');
    const name = host.querySelector<HTMLInputElement>('.re-page .ui-input')!;
    name.value = 'Build box';
    name.dispatchEvent(new Event('input'));
    await nextTick();
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    expect(test).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith('devbox', { name: 'Build box', host: 'old.example.test', remoteBin: '/opt/kimi' });
    await flush();
    expect(host.querySelector('.re-row-name')?.textContent).toContain('Build box');
  });

  it('checks a new name against the names of other hosts, not their ids', async () => {
    mountPanel({
      hosts: [
        sshHost('host-11111111', { name: 'Build box', host: 'a.example.test' }),
        sshHost('plain', { host: 'b.example.test' }),
      ],
    });
    await openDraft('Build box', 'c.example.test');

    expect(saveButton().disabled).toBe(true);
    await fillForm('plain', 'c.example.test');
    expect(saveButton().disabled).toBe(true);
    await fillForm('host-11111111', 'c.example.test');
    expect(saveButton().disabled).toBe(false);
    await fillForm('local', 'c.example.test');
    expect(saveButton().disabled).toBe(false);
  });

  it('generates another id when the first one is taken', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-0000-4000-8000-000000000000')
      .mockReturnValueOnce('22222222-0000-4000-8000-000000000000');
    const { save } = mountPanel({ hosts: [sshHost('host-11111111', { host: 'a.example.test' })] });
    await openDraft('second', 'b.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith('host-22222222', expect.objectContaining({ name: 'second' })));
  });

  it('deletes a host after confirmation', async () => {
    const { remove } = mountPanel({
      hosts: [sshHost('devbox', { name: 'Build box', host: 'dev@example.test' }), sshHost('other')],
    });
    await flush();
    await openRowMenu();
    host.querySelector<HTMLButtonElement>('.re-row-menu .is-danger')!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.message).toContain('Build box'));
    useConfirmDialog().settle(true);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('devbox'));
    await flush();
    expect([...host.querySelectorAll('.re-row-name')].map((node) => node.textContent)).toEqual(['other']);
  });
});

describe('HostsPanel status', () => {
  it('disables hosts without dropping their settings or reconnecting failed ones', async () => {
    const { save, connect } = mountPanel({
      hosts: [
        sshHost('devbox', { host: 'dev@example.test', identityFile: '~/.ssh/id', status: 'ready' }),
        sshHost('flaky', { host: 'flaky@example.test', status: 'disconnected', connectError: 'connect timed out', connectFailure: 'connect_timeout' }),
      ],
    });
    await flush();
    const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.re-row .ui-switch')];

    toggles()[0]!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('devbox', { host: 'dev@example.test', identityFile: '~/.ssh/id', enabled: false });

    await flush();
    toggles()[1]!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('flaky', { host: 'flaky@example.test', enabled: false });
    expect(connect).not.toHaveBeenCalled();

    await flush();
    expect(toggles().map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(host.querySelectorAll('.re-row.disabled')).toHaveLength(2);
    expect(host.querySelector('.re-row-action')).toBeNull();
  });

  it('connects as soon as a host is enabled and keeps it enabled when the connection fails', async () => {
    const { save, connect } = mountPanel({
      hosts: [sshHost('devbox', {
        host: 'dev@example.test',
        enabled: false,
        status: 'disconnected',
        connectError: 'ssh: connect to host dev port 22: Connection refused',
        connectFailure: 'connection_refused',
      })],
    });
    await flush();
    expect(host.querySelector('.re-row-error')).toBeNull();
    expect(host.querySelector('.re-row-action')).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>('.re-row .ui-switch')!;
    toggle.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('devbox'));

    expect(save).toHaveBeenCalledWith('devbox', { host: 'dev@example.test' });
    expect(save.mock.calls[0]![1].enabled).toBeUndefined();
    await flush();
    expect(host.querySelector('.re-row-error')).not.toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.re-row.disabled')).toBeNull();

    expect(host.querySelector('.re-row-action')).toBeNull();
    await expandFailure();
    host.querySelector<HTMLButtonElement>('.re-row-failure .re-row-action')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledOnce();
  });

});

describe('HostsPanel SSH config hosts', () => {
  const hosts: AppSshConfigHosts = {
    configPath: '/home/me/.ssh/config',
    exists: true,
    hosts: [
      { alias: 'devbox' },
      { alias: 'gpu', hostName: 'gpu.example.test', user: 'me', port: 2222 },
      { alias: 'staging' },
    ],
  };

  function hostRow(alias: string): HTMLElement {
    return [...host.querySelectorAll<HTMLElement>('.re-host')].find((row) => row.querySelector('.re-row-name')?.textContent === alias)!;
  }

  function hostNames(): (string | null | undefined)[] {
    return [...host.querySelectorAll('.re-host .re-row-name')].map((node) => node.textContent);
  }

  async function mountHosts(options: Parameters<typeof mountPanel>[0] = {}) {
    const mounted = mountPanel({ hosts: [sshHost('devbox')], loadSshHosts: async () => hosts, ...options });
    await flush();
    expect(host.querySelector('.re-hosts')).toBeNull();
    addButton().click();
    await vi.waitFor(() => expect(host.querySelector('.re-host')).not.toBeNull());
    return mounted;
  }

  it('lists unconfigured hosts on the add page and shows the target only when it differs', async () => {
    const openSshConfig = vi.fn();
    await mountHosts({ openSshConfig });

    expect(hostNames()).toEqual(['gpu', 'staging']);
    expect(hostRow('gpu').querySelector('.re-host-target')?.textContent).toBe('me@gpu.example.test:2222');
    expect(hostRow('staging').querySelector('.re-host-target')).toBeNull();
    host.querySelector<HTMLButtonElement>('.re-hosts-open')!.click();
    expect(openSshConfig).toHaveBeenCalledExactlyOnceWith('/home/me/.ssh/config');
  });

  it('keeps every configured host out of the list after navigating away and back', async () => {
    await mountHosts();
    host.querySelector<HTMLButtonElement>('.re-back')!.click();
    await nextTick();
    await openRowEditor(0);
    host.querySelector<HTMLButtonElement>('.re-back')!.click();
    await nextTick();
    addButton().click();
    await nextTick();
    expect(hostNames()).toEqual(['gpu', 'staging']);

    expect(host.querySelector('.re-page-head .ui-button')).toBeNull();
    const tabs = () => host.querySelectorAll<HTMLButtonElement>('.re-hosts-head [role="tab"]');
    expect(tabs()).toHaveLength(2);
    tabs()[1]!.click();
    await nextTick();
    expect(host.querySelector('.re-hosts')).toBeNull();
    await fillForm('draft', 'draft@example.test');
    tabs()[0]!.click();
    await nextTick();
    expect(hostNames()).toEqual(['gpu', 'staging']);
    tabs()[1]!.click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('.re-page .ui-input')?.value).toBe('draft');
    host.querySelector<HTMLButtonElement>('.re-back')!.click();
    await nextTick();
    expect(host.querySelector('.re-page')).toBeNull();
    expect(host.querySelector('.re-hosts')).toBeNull();
    expect(host.querySelector('.re-row-name')?.textContent).toBe('devbox');
  });

  it('adds a host in one click by saving it and connecting, without testing first', async () => {
    const { save, test, connect } = await mountHosts();

    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(NEW_ID, { name: 'gpu', host: 'gpu' }));
    await flush();

    expect(test).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledExactlyOnceWith(NEW_ID);
    expect(host.querySelector('.re-hosts')).toBeNull();
    expect([...host.querySelectorAll('.re-group .re-row-name')].map((node) => node.textContent)).toEqual(['devbox', 'gpu']);
    expect(host.querySelector('.re-page')).toBeNull();
    addButton().click();
    await nextTick();
    expect(hostNames()).toEqual(['staging']);
  });

  it('avoids a host name that is already taken', async () => {
    const { save } = await mountHosts({ hosts: [sshHost('other', { name: 'gpu', host: 'other' })] });
    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(NEW_ID, expect.objectContaining({ name: 'gpu-2', host: 'gpu' })));
  });

  it('auto-expands a failed added host in its row with reconnect and edit actions', async () => {
    const save = vi.fn(async (hostId: string, definition: AppHostDefinition) => {
      hostsStore().byId = {
        ...hostsStore().byId,
        [hostId]: { id: hostId, ...definition, status: 'disconnected', connectError: 'Permission denied (publickey)', connectFailure: 'authentication_failed' },
      };
    });
    await mountHosts({ save });
    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await vi.waitFor(() => expect(host.querySelector('.re-row-failure')).not.toBeNull());

    expect(host.querySelector('.re-row-failure .etr-hint')?.textContent).toContain('SSH');
    host.querySelector<HTMLButtonElement>('.re-row-failure .re-row-edit')!.click();
    await nextTick();
    const inputs = host.querySelectorAll<HTMLInputElement>('.re-page .ui-input');
    expect(inputs[0]!.value).toBe('gpu');
    expect(inputs[1]!.value).toBe('gpu');
  });

  it('adds one host at a time', async () => {
    let finish: () => void = () => undefined;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mountHosts({ save });

    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await flush();
    expect(hostRow('staging').querySelector<HTMLButtonElement>('.re-host-add')!.disabled).toBe(true);
    hostRow('staging').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await flush();
    expect(save).toHaveBeenCalledOnce();

    finish();
    await flush();
    addButton().click();
    await nextTick();
    expect(hostRow('staging').querySelector<HTMLButtonElement>('.re-host-add')!.disabled).toBe(false);
  });

  it('reports a read failure on the add page and reads again on request', async () => {
    const loadSshHosts = vi.fn<() => Promise<AppSshConfigHosts>>()
      .mockResolvedValueOnce(hosts)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(hosts);
    await mountHosts({ loadSshHosts });

    host.querySelector<HTMLButtonElement>('.re-hosts-refresh')!.click();
    await vi.waitFor(() => expect(host.querySelector('.re-hosts-note')).not.toBeNull());

    host.querySelector<HTMLButtonElement>('.re-hosts-refresh')!.click();
    await vi.waitFor(() => expect(hostNames()).toEqual(['gpu', 'staging']));
    expect(loadSshHosts).toHaveBeenCalledTimes(3);
  });

  it('goes straight to the form when the SSH config cannot be read', async () => {
    mountPanel({ hosts: [sshHost('devbox')], loadSshHosts: async () => { throw new Error('nope'); } });
    await flush();

    addButton().click();
    await vi.waitFor(() => expect(host.querySelector('.re-page .ui-input')).not.toBeNull());
    expect(host.querySelector('.re-hosts')).toBeNull();
  });

  it('keeps the empty list on level 1 and opens the add subpage with persistent source tabs', async () => {
    mountPanel({ loadSshHosts: async () => hosts });
    await flush();

    expect(host.querySelector('.re-empty')).not.toBeNull();
    expect(host.querySelector('.re-hosts')).toBeNull();
    addButton().click();
    await nextTick();
    expect(host.querySelector('.re-back')).not.toBeNull();
    expect(hostNames()).toEqual(['devbox', 'gpu', 'staging']);
    const tabs = () => host.querySelectorAll<HTMLButtonElement>('.re-hosts-head [role="tab"]');
    expect(tabs()).toHaveLength(2);
    tabs()[1]!.click();
    await nextTick();
    expect(host.querySelectorAll('.re-page .ui-input')).toHaveLength(3);
    expect(host.querySelectorAll('.re-foot-actions .ui-button')).toHaveLength(2);
  });

  it('keeps the source switcher visible with an empty state and reload button when ~/.ssh/config is missing or fully added', async () => {
    const loadSshHosts = vi.fn<() => Promise<AppSshConfigHosts>>()
      .mockResolvedValueOnce({ configPath: '/home/me/.ssh/config', exists: false, hosts: [] })
      .mockResolvedValueOnce({ configPath: '/home/me/.ssh/config', exists: true, hosts: [{ alias: 'devbox' }] });
    mountPanel({ hosts: [sshHost('devbox')], loadSshHosts });
    await flush();

    addButton().click();
    await nextTick();
    const tabs = () => host.querySelectorAll<HTMLButtonElement>('.re-hosts-head [role="tab"]');
    expect(tabs()).toHaveLength(2);
    tabs()[0]!.click();
    await nextTick();
    expect(host.querySelector('.re-hosts-note')?.textContent).toContain('No ~/.ssh/config found');

    host.querySelector<HTMLButtonElement>('.re-hosts-refresh')!.click();
    await vi.waitFor(() => expect(host.querySelector('.re-hosts-note')?.textContent).toContain('All hosts from ~/.ssh/config'));
  });

  it('picks an identity file starting in the SSH config folder', async () => {
    const pickIdentityFile = vi.fn(async () => '/home/me/.ssh/work_ed25519');
    mountPanel({
      loadSshHosts: async () => ({ configPath: '/home/me/.ssh/config', exists: true, hosts: [] }),
      pickIdentityFile,
    });
    await flush();

    addButton().click();
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>('.re-page .ui-button')].find((button) => button.textContent?.includes('Choose'))!.click();
    await vi.waitFor(() => expect(pickIdentityFile).toHaveBeenCalledExactlyOnceWith('/home/me/.ssh'));
    await flush();
    expect(host.querySelectorAll<HTMLInputElement>('.re-page .ui-input')[2]!.value).toBe('/home/me/.ssh/work_ed25519');
  });
});

describe('HostsPanel navigation and row actions', () => {
  it('opens the add page when settings are focused with no hosts', async () => {
    const { store } = mountPanel({
      hosts: [],
      loadSshHosts: async () => ({ configPath: '/home/me/.ssh/config', exists: true, hosts: [{ alias: 'devbox' }] }),
    });
    await flush();
    expect(host.querySelector('.re-page')).toBeNull();

    store.requestFocus(null, { addIfEmpty: true });
    await flush();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('Add host');
    expect(host.querySelector('.re-hosts')).not.toBeNull();
    expect(host.querySelector('.re-page .ui-input')).toBeNull();
    expect(store.addIfEmpty).toBe(false);

    store.requestFocus(null, { addIfEmpty: true });
    expect(store.addIfEmpty).toBe(true);
    store.requestFocus(null);
    await flush();
    expect(store.addIfEmpty).toBe(false);
    expect(host.querySelector('.re-page-title')?.textContent).toContain('Add host');
    expect(host.querySelector('.re-hosts')).not.toBeNull();
  });

  it('opens the manual form from an empty host list only after SSH config has nothing to add', async () => {
    const { store } = mountPanel({
      hosts: [],
      loadSshHosts: async () => ({ configPath: '/home/me/.ssh/config', exists: true, hosts: [] }),
    });
    await flush();

    store.requestFocus(null, { addIfEmpty: true });
    await flush();
    expect(host.querySelector('.re-page .ui-input')).not.toBeNull();
    expect(host.querySelector('.re-hosts')).toBeNull();
  });

  it('surfaces New project directly on ready rows without jumping to edit on row click, and expands focused hosts', async () => {
    const createProject = vi.fn();
    const { connect, store } = mountPanel({
      hosts: [
        sshHost('ready-box', { status: 'ready' }),
        sshHost('broken-box', { status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' }),
        sshHost('paused', { enabled: false }),
      ],
      createProject,
    });
    await flush();

    host.querySelector<HTMLElement>('.re-row-lead')!.click();
    await nextTick();
    expect(host.querySelector('.re-page')).toBeNull();

    const createButtons = host.querySelectorAll<HTMLButtonElement>('.re-row-create-project');
    expect(createButtons).toHaveLength(3);
    expect(createButtons[0]!.querySelector('[data-icon="folder-plus"]')).not.toBeNull();
    expect(createButtons[0]!.textContent).toBe('');
    expect(createButtons[0]!.disabled).toBe(false);
    expect(createButtons[1]!.disabled).toBe(true);
    expect(createButtons[1]!.getAttribute('aria-label')).toContain('Connect to create a project');
    expect(createButtons[0]!.compareDocumentPosition(host.querySelector('.re-row-more')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    createButtons[1]!.click();
    createButtons[0]!.click();
    expect(createProject).toHaveBeenCalledExactlyOnceWith('ready-box');

    store.requestFocus('broken-box');
    await flush();
    expect(store.focusHostId).toBeNull();
    expect(host.querySelector('.re-row-failure')).not.toBeNull();

    store.connecting = { 'broken-box': true };
    await nextTick();
    const retryingRow = [...host.querySelectorAll<HTMLElement>('.re-item')].find((item) => item.dataset.hostId === 'broken-box')!;
    expect(retryingRow.querySelector('.re-row-state')?.textContent).toContain('Retrying');
    expect(retryingRow.querySelector('.re-row-failure')).not.toBeNull();
    store.connecting = {};
    await nextTick();

    await openRowMenu(0);
    [...host.querySelectorAll<HTMLButtonElement>('.re-row-menu .ui-menu-item')].find((item) => item.textContent?.includes('Reconnect'))!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('ready-box'));
  });
});

describe('HostsPanel model setup', () => {
  function rowOf(id: string): HTMLElement {
    return [...host.querySelectorAll<HTMLElement>('.re-item')].find((item) => item.querySelector('.re-row-name')?.textContent === id)!;
  }

  function statusOf(id: string): string {
    return rowOf(id).querySelector('.re-row-status')?.textContent ?? '';
  }

  async function openMenu(id: string): Promise<void> {
    rowOf(id).querySelector<HTMLButtonElement>('.re-row-more')!.click();
    await flush();
    expect(host.querySelector('.re-row-menu')).not.toBeNull();
  }

  function menuItem(selector: string): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(`.re-row-menu ${selector}`);
  }

  it('flags only connected hosts without models and offers both fixes inline', async () => {
    const { signIn, copyProviders } = mountPanel({
      hosts: [sshHost('devbox', { status: 'ready' }), sshHost('named', { status: 'ready' }), sshHost('idle-box')],
      accounts: {
        devbox: { status: 'signedOut', modelsReady: false },
        named: { status: 'signedIn', modelsReady: true },
        'idle-box': { status: 'signedOut', modelsReady: false },
      },
    });
    await flush();

    expect(rowOf('named').querySelector('.re-row-warning')).toBeNull();
    expect(rowOf('idle-box').querySelector('.re-row-warning')).toBeNull();
    const flag = rowOf('devbox').querySelector<HTMLButtonElement>('.re-row-warning')!;
    expect(flag.getAttribute('aria-expanded')).toBe('false');
    expect(rowOf('devbox').querySelector('.re-row-setup')).toBeNull();

    flag.click();
    await flush();
    expect(flag.getAttribute('aria-expanded')).toBe('true');
    rowOf('devbox').querySelector<HTMLButtonElement>('.re-row-sign-in')!.click();
    expect(signIn).toHaveBeenCalledExactlyOnceWith('devbox');
    rowOf('devbox').querySelector<HTMLButtonElement>('.re-row-copy-local')!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.title).toContain('devbox'));
    useConfirmDialog().settle(true);
    await vi.waitFor(() => expect(copyProviders).toHaveBeenCalledExactlyOnceWith('devbox'));
  });

  it('keeps model actions in the row menu and surfaces sign-out errors', async () => {
    const signOut = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const { signIn } = mountPanel({
      hosts: [sshHost('devbox', { status: 'ready' }), sshHost('named', { status: 'ready' }), sshHost('idle-box')],
      accounts: {
        devbox: { status: 'signedOut', modelsReady: true },
        named: { status: 'signedIn', modelsReady: true },
      },
      signOut,
    });
    await flush();

    await openMenu('idle-box');
    expect(menuItem('.re-menu-sign-in')).toBeNull();
    expect(menuItem('.re-menu-copy')).toBeNull();

    await openMenu('devbox');
    expect(menuItem('.re-menu-sign-out')).toBeNull();
    expect(menuItem('.re-menu-copy')).not.toBeNull();
    menuItem('.re-menu-sign-in')!.click();
    await flush();
    expect(signIn).toHaveBeenCalledExactlyOnceWith('devbox');
    await vi.waitFor(() => expect(host.querySelector('.re-row-menu')).toBeNull());

    await openMenu('named');
    expect(menuItem('.re-menu-sign-out')?.textContent).toContain('Sign out of Kimi');
    menuItem('.re-menu-sign-out')!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(signOut).toHaveBeenCalledExactlyOnceWith('named');

    await openMenu('named');
    menuItem('.re-menu-edit')!.click();
    await flush();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('named');
  });

  it('keeps Copy local custom providers in the menu and retries loading account when account fetch had failed', async () => {
    const { loadAccount } = mountPanel({
      hosts: [sshHost('devbox', { status: 'ready' })],
      accounts: {},
    });
    await flush();

    await openMenu('devbox');
    expect(loadAccount).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(menuItem('.re-menu-copy')).not.toBeNull();
  });

  it('reports a copy started from the menu on the status line', async () => {
    vi.useFakeTimers();
    try {
      const { store, copyProviders } = mountPanel({
        hosts: [sshHost('devbox', { status: 'ready' })],
        accounts: { devbox: { status: 'signedIn', modelsReady: true } },
      });
      store.providerCopies = { devbox: { status: 'failed' } };
      await flush();
      expect(statusOf('devbox')).toContain('devbox');

      await openMenu('devbox');
      menuItem('.re-menu-copy')!.click();
      await flush();
      expect(useConfirmDialog().current.value?.title).toContain('devbox');
      useConfirmDialog().settle(false);
      await flush();
      expect(copyProviders).not.toHaveBeenCalled();

      await openMenu('devbox');
      menuItem('.re-menu-copy')!.click();
      await flush();
      useConfirmDialog().settle(true);
      await flush();
      expect(copyProviders).toHaveBeenCalledExactlyOnceWith('devbox');

      store.providerCopies = { devbox: { status: 'copying' } };
      await flush();

      store.providerCopies = { devbox: { status: 'failed' } };
      await flush();
      const flag = rowOf('devbox').querySelector<HTMLButtonElement>('.re-row-warning')!;
      flag.click();
      await flush();
      rowOf('devbox').querySelector<HTMLButtonElement>('.re-row-copy-retry')!.click();
      expect(copyProviders).toHaveBeenCalledTimes(2);

      store.providerCopies = { devbox: { status: 'done', result: { providers: ['gateway', 'backup'] } } };
      await flush();
      expect(statusOf('devbox')).toContain('gateway');
      vi.advanceTimersByTime(4000);
      await flush();
      expect(statusOf('devbox')).not.toContain('gateway');
      expect(statusOf('devbox')).toContain('devbox');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HostsPanel connection test steps', () => {
  function pendingTest() {
    const signals: AbortSignal[] = [];
    const resolvers: Array<() => void> = [];
    const test = vi.fn((_definition: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AppHostTestResult>((resolve) => resolvers.push(() => resolve({ connected: true })));
    });
    return { test, signals, resolvers };
  }

  function cancelButton(): HTMLButtonElement {
    return host.querySelectorAll<HTMLButtonElement>('.re-foot-actions .ui-button')[0]!;
  }

  function saveAnywayButton(): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('.re-foot .re-save-anyway');
  }

  it('shows one line while testing, blocks saving, and saves as soon as the test passes', async () => {
    const { test, resolvers } = pendingTest();
    const { save } = mountPanel({ test });
    await openDraft();
    expect(host.querySelector('.etr')).toBeNull();

    saveButton().click();
    await flush();
    expect(host.querySelector('.re-foot .etr-line--running')).not.toBeNull();
    expect(host.querySelector('.etr-endpoint')?.textContent).toBe('dev@example.test');
    expect(host.querySelector('.etr-step')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    await flush();
    expect(save).not.toHaveBeenCalled();

    resolvers[0]!();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await flush();
    expect(host.querySelector('.re-page')).toBeNull();
  });

  it('offers retry and save anyway after a failure and saves once the host is reachable', async () => {
    const test = vi.fn<() => Promise<AppHostTestResult>>()
      .mockResolvedValueOnce(failedTest('unreachable'))
      .mockResolvedValueOnce({ connected: true });
    const { save } = mountPanel({ test });
    await openDraft();
    expect(saveAnywayButton()).toBeNull();

    saveButton().click();
    await vi.waitFor(() => expect(saveAnywayButton()).not.toBeNull());
    expect(save).not.toHaveBeenCalled();

    await fillForm('devbox', 'other.example.test');
    expect(host.querySelector('.etr')).toBeNull();
    expect(saveAnywayButton()).toBeNull();

    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('tests changed connection settings on enabled hosts only and keeps the old ones on failure', async () => {
    const test = vi.fn(async () => failedTest('unreachable'));
    const { save, store } = mountPanel({
      test,
      hosts: [
        sshHost('paused', { name: 'Paused box', host: 'old.example.test', enabled: false }),
        sshHost('devbox', { name: 'Build box', host: 'old.example.test' }),
      ],
    });
    await openRowEditor(0);
    await fillForm('Paused box', 'new.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('paused', { name: 'Paused box', host: 'new.example.test', enabled: false }));
    expect(test).not.toHaveBeenCalled();

    await openRowEditor(1);
    await fillForm('Build box', 'new.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(saveAnywayButton()).not.toBeNull());
    expect(save).toHaveBeenCalledOnce();
    expect(store.byId['devbox']).toMatchObject({ name: 'Build box', host: 'old.example.test' });
  });

  it('shows the failure itself without a step list', async () => {
    const test = vi.fn<() => Promise<AppHostTestResult>>()
      .mockResolvedValueOnce(failedTest('ssh failed', 'authentication_failed'))
      .mockResolvedValueOnce(failedTest('kimi: not found', 'executor_not_found'));
    mountPanel({ test });
    await openDraft();

    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-failure')).not.toBeNull());
    expect(host.querySelector('.etr-step')).toBeNull();
    expect(host.querySelector('.etr-reason')?.textContent).toContain('SSH authentication failed');
    expect(host.querySelector('.etr-install-command')).toBeNull();

    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-install-command')).not.toBeNull());
    expect(host.querySelector('.etr-step')).toBeNull();
    expect(host.querySelector('.etr-reason')?.textContent).toContain('Kimi Code CLI');
  });

  it('opens the raw output when an unclassified failure has no reason and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const test = vi.fn(async () => failedTest('ssh: Could not connect', 'unknown'));
    mountPanel({ test });
    await openDraft();

    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-failure')).not.toBeNull());
    expect(host.querySelector('.etr-reason')).toBeNull();
    expect(host.querySelector('.etr-detail')?.textContent).toContain('ssh: Could not connect');

    host.querySelector<HTMLButtonElement>('.etr-copy')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('ssh: Could not connect'));
  });

  it('aborts a running test in place and ignores its late result', async () => {
    const { test, signals, resolvers } = pendingTest();
    const { save } = mountPanel({ test });
    await openDraft();

    saveButton().click();
    await flush();
    expect(cancelButton().disabled).toBe(false);
    cancelButton().click();
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    expect(host.querySelector('.re-page')).not.toBeNull();
    expect(host.querySelector('.etr')).toBeNull();

    resolvers[0]!();
    await flush();
    expect(host.querySelector('.etr')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['leaving the form', () => { host.querySelector<HTMLButtonElement>('.re-back')!.click(); }],
    ['the panel going away', () => { app!.unmount(); app = undefined; }],
  ])('aborts a running test when %s', async (_label, leave) => {
    const { test, signals } = pendingTest();
    mountPanel({ test });
    await openDraft();

    saveButton().click();
    await flush();
    leave();
    await flush();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('saves an unreachable host anyway and shows it in the list', async () => {
    const test = vi.fn(async () => failedTest('unreachable'));
    const connect = vi.fn(async () => { throw new Error('unreachable'); });
    const { save } = mountPanel({ test, connect });
    await openDraft();

    saveButton().click();
    await vi.waitFor(() => expect(saveAnywayButton()).not.toBeNull());
    expect(save).not.toHaveBeenCalled();

    saveAnywayButton()!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await flush();
    expect(test).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledExactlyOnceWith(NEW_ID);
    expect(host.querySelector('.re-page')).toBeNull();
    expect(host.querySelector('.re-row-name')?.textContent).toContain('devbox');
  });

  it('reports a failed save and keeps the form open', async () => {
    const save = vi.fn(async () => { throw new Error('write failed'); });
    mountPanel({ save });
    await openDraft();

    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await flush();
    expect(host.querySelector('.re-page')).not.toBeNull();
    expect(host.querySelector('.re-foot [role="alert"]')).not.toBeNull();
  });
});
