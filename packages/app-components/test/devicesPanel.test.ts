// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppDevice, AppDeviceDefinition, AppDeviceTestResult, AppSshConfigHosts } from '@moonshot-ai/app-core/api';
import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { authStore, configStore, devicesStore, setDevicesHooks, warningsStore, type DeviceAccount } from '@moonshot-ai/app-client/stores';
import DevicesPanel from '../src/settings/DevicesPanel.vue';
import DeviceTestResult from '../src/settings/DeviceTestResult.vue';

let app: App | undefined;
let host: HTMLDivElement;

const NEW_ID = 'device-a1b2c3d4';

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('a1b2c3d4-0000-4000-8000-000000000000');
  setDevicesHooks({
    signedIn: () => authStore().signedIn,
    localDeviceId: () => configStore().deviceId,
    pushWarning: (warning) => warningsStore().pushWarning(warning),
    pushOperationFailure: warningsStore().pushOperationFailure,
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  useConfirmDialog().settle(false);
  setDevicesHooks(null);
  authStore().managedProviderStatus = null;
  configStore().deviceId = '';
  const store = devicesStore();
  store.byId = {};
  store.loaded = false;
  store.connecting = {};
  store.providerCopies = {};
  store.accounts = {};
  store.loginDeviceId = null;
  store.settledFailures = {};
  store.registrations = null;
  store.maxDevices = undefined;
  store.registrationsError = null;
  store.registrationsLoading = false;
  store.upgradeRequests = {};
  store.focusDeviceId = null;
  store.addIfEmpty = false;
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function sshDevice(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: id, status: 'pending', ...extra };
}

function failedTest(connectError: string, connectFailure?: AppDeviceTestResult['connectFailure']): AppDeviceTestResult {
  return { connected: false, connectError, connectFailure };
}

function mountPanel(options: {
  devices?: AppDevice[];
  test?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
  loadSshHosts?: () => Promise<AppSshConfigHosts>;
  openSshConfig?: (path: string) => void;
  connect?: (deviceId: string) => Promise<unknown>;
  connecting?: Record<string, boolean>;
  pickIdentityFile?: (defaultPath?: string) => Promise<string | undefined>;
  createProject?: (deviceId: string) => void;
  copyProviders?: (deviceId: string) => Promise<void>;
  accounts?: Record<string, DeviceAccount>;
  loadAccount?: (deviceId: string) => Promise<void>;
  signIn?: (deviceId: string) => void;
  signOut?: (deviceId: string) => Promise<void>;
  signedIn?: boolean;
  registrations?: RcDevice[] | null;
  maxDevices?: number;
  thisDevice?: boolean;
  onLogin?: () => void;
} = {}) {
  const store = devicesStore();
  if (options.signedIn === true) authStore().managedProviderStatus = 'authenticated';
  configStore().deviceId = 'this-mac';
  store.byId = Object.fromEntries((options.devices ?? []).map((row) => [row.id, row]));
  store.loaded = true;
  store.connecting = options.connecting ?? {};
  store.providerCopies = {};
  store.accounts = options.accounts ?? {};
  store.registrations = options.registrations ?? null;
  store.maxDevices = options.maxDevices;

  const test = options.test ?? vi.fn(async (): Promise<AppDeviceTestResult> => ({ connected: true }));
  const save = options.save ?? vi.fn(async (deviceId: string, definition: AppDeviceDefinition) => {
    const existing = store.byId[deviceId];
    store.byId = {
      ...store.byId,
      [deviceId]: existing === undefined ? { id: deviceId, status: 'pending', ...definition } : { ...existing, ...definition },
    };
  });
  const remove = vi.fn(async (deviceId: string) => {
    const next = { ...store.byId };
    delete next[deviceId];
    store.byId = next;
  });
  const connect = vi.fn(options.connect ?? (async () => undefined));
  const copyProviders = vi.fn(options.copyProviders ?? (async () => undefined));
  const loadAccount = vi.fn(options.loadAccount ?? (async () => undefined));
  const signIn = vi.fn(options.signIn ?? (() => undefined));
  const signOut = vi.fn(options.signOut ?? (async () => undefined));

  vi.spyOn(store, 'load').mockImplementation(async () => store.devices);
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
  const loadRegistrations = vi.spyOn(store, 'loadRegistrations').mockResolvedValue();
  const addAccountDevice = vi.spyOn(store, 'addAccountDevice').mockImplementation(async (deviceId) => {
    store.byId = { ...store.byId, [deviceId]: { id: deviceId, connection: 'account', status: 'connecting' } };
  });
  const renameRegistration = vi.spyOn(store, 'renameRegistration').mockResolvedValue();
  const deactivateRegistration = vi.spyOn(store, 'deactivateRegistration').mockResolvedValue();
  const deleteRegistration = vi.spyOn(store, 'deleteRegistration').mockResolvedValue();

  app = createApp({
    render: () => h(DevicesPanel, {
      openSshConfig: options.openSshConfig,
      pickIdentityFile: options.pickIdentityFile,
      createProject: options.createProject,
      onLogin: options.onLogin,
    }, options.thisDevice === true ? { 'this-device': () => h('div', { class: 'this-device-probe' }, 'Remote Control') } : undefined),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return { store, test, save, remove, connect, copyProviders, loadAccount, signIn, signOut, loadRegistrations, addAccountDevice, renameRegistration, deactivateRegistration, deleteRegistration };
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

describe('DeviceTestResult', () => {
  it.each([
    ['executor_not_found', '.etr-install-command', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
    ['outdated', '.etr-update-command', 'kimi upgrade'],
  ] as const)('copies the recovery command for %s', async (failure, selector, command) => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    app = createApp({ render: () => h(DeviceTestResult, { state: 'failed', endpoint: 'devbox', failure, reason: 'Failed', detail: 'raw' }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);

    const button = host.querySelector<HTMLButtonElement>(selector)!;
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(command));
    await vi.waitFor(() => expect(button.textContent).toContain('Copied'));
  });
});

describe('DevicesPanel', () => {
  it('tests a new device before saving it and connects right after without copying providers', async () => {
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
    expect(save).toHaveBeenCalledWith(NEW_ID, { connection: 'ssh', name: 'devbox', host: 'dev@example.test', identityFile: '~/.ssh/devbox_ed25519' });
    expect(copyProviders).not.toHaveBeenCalled();
    expect(host.querySelector('.re-page')).toBeNull();
    expect(host.querySelector('.re-row-name')?.textContent).toContain('devbox');
    expect(host.querySelector('.re-row-status')?.textContent ?? '').not.toContain('dev@example.test');
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
    const test = vi.fn(async (): Promise<AppDeviceTestResult> => ({
      connected: false,
      remoteVersion: '0.40.0',
      connectError: "error: unknown option '--probe'",
      connectFailure: 'outdated',
    }));
    mountPanel({ test });
    await openDraft();
    saveButton().click();
    await vi.waitFor(() => expect(host.querySelector('.etr-reason')).not.toBeNull());

    expect(host.querySelector('.etr-reason')?.textContent).toContain('0.40.0');
    expect(host.querySelector('.etr-hint')).not.toBeNull();
    expect(host.querySelector('.etr-detail')?.textContent).toContain("unknown option '--probe'");
    expect(host.querySelector('.etr-step')).toBeNull();
  });

  it('offers failure guidance, reconnect, and edit in the expanded row', async () => {
    const { connect } = mountPanel({
      devices: [sshDevice('devbox', { status: 'disconnected', connectError: 'raw', connectFailure: 'authentication_failed' })],
    });
    await flush();

    expect(host.querySelector('.re-row-details-text')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.re-row .re-row-reconnect')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('devbox'));
    await expandFailure();
    expect(host.querySelector('.re-row-failure .etr-hint')).not.toBeNull();
    expect(host.querySelector('.re-row-failure .re-row-reconnect')).toBeNull();
    host.querySelector<HTMLButtonElement>('.re-row-failure .re-row-edit')!.click();
    await nextTick();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('devbox');
  });

  it('renames a device without testing it, and omits the name when an unnamed device is unchanged', async () => {
    const { save, test } = mountPanel({
      devices: [sshDevice('devbox', { host: 'old.example.test', remoteBin: '/opt/kimi' }), sshDevice('other')],
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
    expect(save).toHaveBeenLastCalledWith('devbox', { connection: 'ssh', name: 'Build box', host: 'old.example.test', remoteBin: '/opt/kimi' });
    await flush();
    expect(host.querySelector('.re-row-name')?.textContent).toContain('Build box');
  });

  it('checks a new name against the names of other devices, not their ids', async () => {
    mountPanel({
      devices: [
        sshDevice('device-11111111', { name: 'Build box', host: 'a.example.test' }),
        sshDevice('plain', { host: 'b.example.test' }),
      ],
    });
    await openDraft('Build box', 'c.example.test');

    expect(saveButton().disabled).toBe(true);
    await fillForm('plain', 'c.example.test');
    expect(saveButton().disabled).toBe(true);
    await fillForm('device-11111111', 'c.example.test');
    expect(saveButton().disabled).toBe(false);
    await fillForm('local', 'c.example.test');
    expect(saveButton().disabled).toBe(false);
  });

  it('generates another id when the first one is taken', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-0000-4000-8000-000000000000')
      .mockReturnValueOnce('22222222-0000-4000-8000-000000000000');
    const { save } = mountPanel({ devices: [sshDevice('device-11111111', { host: 'a.example.test' })] });
    await openDraft('second', 'b.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith('device-22222222', expect.objectContaining({ name: 'second' })));
  });

  it('deletes a device after confirmation', async () => {
    const { remove } = mountPanel({
      devices: [sshDevice('devbox', { name: 'Build box', host: 'dev@example.test' }), sshDevice('other')],
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

describe('DevicesPanel status', () => {
  it('disables devices without dropping their settings or reconnecting failed ones', async () => {
    const { save, connect } = mountPanel({
      devices: [
        sshDevice('devbox', { host: 'dev@example.test', identityFile: '~/.ssh/id', status: 'ready' }),
        sshDevice('flaky', { host: 'flaky@example.test', status: 'disconnected', connectError: 'connect timed out', connectFailure: 'connect_timeout' }),
      ],
    });
    await flush();
    const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.re-row .ui-switch')];

    toggles()[0]!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('devbox', { connection: 'ssh', host: 'dev@example.test', identityFile: '~/.ssh/id', enabled: false });

    await flush();
    toggles()[1]!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('flaky', { connection: 'ssh', host: 'flaky@example.test', enabled: false });
    expect(connect).not.toHaveBeenCalled();

    await flush();
    expect(toggles().map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(host.querySelectorAll('.re-row.disabled')).toHaveLength(2);
    expect(host.querySelector('.re-row-action')).toBeNull();
  });

  it('connects as soon as a device is enabled and keeps it enabled when the connection fails', async () => {
    const { save, connect } = mountPanel({
      devices: [sshDevice('devbox', {
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

    expect(save).toHaveBeenCalledWith('devbox', { connection: 'ssh', host: 'dev@example.test' });
    expect(save.mock.calls[0]![1].enabled).toBeUndefined();
    await flush();
    expect(host.querySelector('.re-row-error')).not.toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.re-row.disabled')).toBeNull();

    host.querySelector<HTMLButtonElement>('.re-row .re-row-action')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledOnce();
  });

});

describe('DevicesPanel SSH config hosts', () => {
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
    const mounted = mountPanel({ devices: [sshDevice('devbox')], loadSshHosts: async () => hosts, ...options });
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
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(NEW_ID, { connection: 'ssh', name: 'gpu', host: 'gpu' }));
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

  it('avoids a device name that is already taken', async () => {
    const { save } = await mountHosts({ devices: [sshDevice('other', { name: 'gpu', host: 'other' })] });
    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(NEW_ID, expect.objectContaining({ name: 'gpu-2', host: 'gpu' })));
  });

  it('auto-expands a failed added device in its row with reconnect and edit actions', async () => {
    const save = vi.fn(async (deviceId: string, definition: AppDeviceDefinition) => {
      devicesStore().byId = {
        ...devicesStore().byId,
        [deviceId]: { id: deviceId, ...definition, status: 'disconnected', connectError: 'Permission denied (publickey)', connectFailure: 'authentication_failed' },
      };
    });
    await mountHosts({ save });
    hostRow('gpu').querySelector<HTMLButtonElement>('.re-host-add')!.click();
    await vi.waitFor(() => expect(host.querySelector('.re-row-failure .etr-hint')).not.toBeNull());
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
    mountPanel({ devices: [sshDevice('devbox')], loadSshHosts: async () => { throw new Error('nope'); } });
    await flush();

    addButton().click();
    await vi.waitFor(() => expect(host.querySelector('.re-page .ui-input')).not.toBeNull());
    expect(host.querySelector('.re-hosts')).toBeNull();
  });

  it('keeps an empty card with the detected host count until Add opens the host picker', async () => {
    mountPanel({ loadSshHosts: async () => hosts });
    await flush();

    expect(host.querySelector('.re-empty')?.textContent?.trim()).toBe('Found 3 hosts in ~/.ssh/config');
    expect(hostNames()).toEqual([]);

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
    mountPanel({ devices: [sshDevice('devbox')], loadSshHosts });
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

describe('DevicesPanel navigation and row actions', () => {
  it('opens the add page for focused empty settings and resets the request after navigating away', async () => {
    const { store } = mountPanel({
      devices: [],
      loadSshHosts: async () => ({ configPath: '/home/me/.ssh/config', exists: true, hosts: [{ alias: 'devbox' }] }),
    });
    await flush();

    store.requestFocus(null, { addIfEmpty: true });
    await vi.waitFor(() => expect(host.querySelector('.re-hosts')).not.toBeNull());
    expect(host.querySelector('.re-page .ui-input')).toBeNull();
    expect(store.addIfEmpty).toBe(false);

    host.querySelector<HTMLButtonElement>('.re-back')!.click();
    store.requestFocus(null, { addIfEmpty: true });
    expect(store.addIfEmpty).toBe(true);
    store.requestFocus(null);
    await vi.waitFor(() => expect(host.querySelector('.re-hosts')).not.toBeNull());
    expect(store.addIfEmpty).toBe(false);
  });

  it('surfaces New project directly on ready rows without jumping to edit on row click, and expands focused devices', async () => {
    const createProject = vi.fn();
    const { connect, store } = mountPanel({
      devices: [
        sshDevice('ready-box', { status: 'ready' }),
        sshDevice('broken-box', { status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' }),
        sshDevice('paused', { enabled: false }),
      ],
      createProject,
    });
    await flush();

    host.querySelector<HTMLElement>('.re-row-lead')!.click();
    await nextTick();
    expect(host.querySelector('.re-page')).toBeNull();

    const createButtons = host.querySelectorAll<HTMLButtonElement>('.re-row-create-project');
    expect(createButtons).toHaveLength(3);
    expect(createButtons[1]!.disabled).toBe(true);
    createButtons[1]!.click();
    createButtons[0]!.click();
    expect(createProject).toHaveBeenCalledExactlyOnceWith('ready-box');

    store.requestFocus('broken-box');
    await flush();
    expect(store.focusDeviceId).toBeNull();
    expect(host.querySelector('.re-row-failure')).not.toBeNull();

    store.connecting = { 'broken-box': true };
    await nextTick();
    const retryingRow = [...host.querySelectorAll<HTMLElement>('.re-item')].find((item) => item.dataset.deviceId === 'broken-box')!;
    expect(retryingRow.querySelector('.re-row-state')?.textContent).toContain('Retrying');
    expect(retryingRow.querySelector('.re-row-failure')).not.toBeNull();
    store.connecting = {};
    await nextTick();

    await openRowMenu(0);
    [...host.querySelectorAll<HTMLButtonElement>('.re-row-menu .ui-menu-item')].find((item) => item.textContent?.includes('Reconnect'))!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('ready-box'));
  });
});

describe('DevicesPanel model setup', () => {
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

  it('flags only connected devices without models and offers both fixes inline', async () => {
    const { signIn, copyProviders } = mountPanel({
      devices: [sshDevice('devbox', { status: 'ready' }), sshDevice('named', { status: 'ready' }), sshDevice('idle-box')],
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
    const { signIn, loadAccount } = mountPanel({
      devices: [sshDevice('devbox', { status: 'ready' }), sshDevice('named', { status: 'ready' }), sshDevice('idle-box')],
      accounts: { named: { status: 'signedIn', modelsReady: true } },
      signOut,
    });
    await flush();

    await openMenu('idle-box');
    expect(menuItem('.re-menu-sign-in')).toBeNull();
    expect(menuItem('.re-menu-copy')).toBeNull();

    await openMenu('devbox');
    expect(menuItem('.re-menu-sign-out')).toBeNull();
    expect(menuItem('.re-menu-sign-in')).toBeNull();
    expect(loadAccount).toHaveBeenCalledExactlyOnceWith('devbox');
    devicesStore().accounts = { ...devicesStore().accounts, devbox: { status: 'signedOut', modelsReady: true } };
    await openMenu('devbox');
    await openMenu('devbox');
    expect(menuItem('.re-menu-copy')).not.toBeNull();
    menuItem('.re-menu-sign-in')!.click();
    await flush();
    expect(signIn).toHaveBeenCalledExactlyOnceWith('devbox');
    await vi.waitFor(() => expect(host.querySelector('.re-row-menu')).toBeNull());

    await openMenu('named');
    menuItem('.re-menu-sign-out')!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(signOut).toHaveBeenCalledExactlyOnceWith('named');

    await openMenu('named');
    menuItem('.re-menu-edit')!.click();
    await flush();
    expect(host.querySelector('.re-page-title')?.textContent).toContain('named');
  });

  it('reports a copy started from the menu on the status line', async () => {
    vi.useFakeTimers();
    try {
      const { store, copyProviders } = mountPanel({
        devices: [sshDevice('devbox', { status: 'ready' })],
        accounts: { devbox: { status: 'signedIn', modelsReady: true } },
      });
      store.providerCopies = { devbox: { status: 'failed' } };
      await flush();
      expect(statusOf('devbox').trim()).toBe('Connected');

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
      expect(statusOf('devbox').trim()).toBe('Connected');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DevicesPanel connection test steps', () => {
  function pendingTest() {
    const signals: AbortSignal[] = [];
    const resolvers: Array<() => void> = [];
    const test = vi.fn((_definition: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AppDeviceTestResult>((resolve) => resolvers.push(() => resolve({ connected: true })));
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

  it('offers retry and save anyway after a failure and saves once the device is reachable', async () => {
    const test = vi.fn<() => Promise<AppDeviceTestResult>>()
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

  it('tests changed connection settings on enabled devices only and keeps the old ones on failure', async () => {
    const test = vi.fn(async () => failedTest('unreachable'));
    const { save, store } = mountPanel({
      test,
      devices: [
        sshDevice('paused', { name: 'Paused box', host: 'old.example.test', enabled: false }),
        sshDevice('devbox', { name: 'Build box', host: 'old.example.test' }),
      ],
    });
    await openRowEditor(0);
    await fillForm('Paused box', 'new.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('paused', { connection: 'ssh', name: 'Paused box', host: 'new.example.test', enabled: false }));
    expect(test).not.toHaveBeenCalled();

    await openRowEditor(1);
    await fillForm('Build box', 'new.example.test');
    saveButton().click();
    await vi.waitFor(() => expect(saveAnywayButton()).not.toBeNull());
    expect(save).toHaveBeenCalledOnce();
    expect(store.byId['devbox']).toMatchObject({ name: 'Build box', host: 'old.example.test' });
  });

  it('shows the failure itself without a step list', async () => {
    const test = vi.fn<() => Promise<AppDeviceTestResult>>()
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

  it('saves an unreachable device anyway and shows it in the list', async () => {
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

function registration(id: string, extra: Partial<RcDevice> = {}): RcDevice {
  return {
    device_id: id,
    alias: id,
    status: 'online',
    platform: 'darwin',
    client_version: 'kimi-code-desktop/1.3.7',
    local_base_url: '',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: new Date().toISOString(),
    last_remote_access_at: '',
    ...extra,
  };
}

function accountRow(name: string): HTMLElement {
  return [...host.querySelectorAll<HTMLElement>('.ad-row')].find((row) => row.querySelector('.ad-name')?.textContent === name)!;
}

function accountRowNames(): (string | null | undefined)[] {
  return [...host.querySelectorAll('.ad-row .ad-name')].map((node) => node.textContent);
}

function statusParts(name: string): (string | null)[] {
  return [...accountRow(name).querySelectorAll('.ad-state, .ad-detail')].map((node) => node.textContent);
}

async function openAccountMenu(name: string): Promise<HTMLButtonElement[]> {
  accountRow(name).querySelector<HTMLButtonElement>('.ad-more')!.click();
  await vi.waitFor(() => expect(host.querySelector('.ad-menu')).not.toBeNull());
  return [...host.querySelectorAll<HTMLButtonElement>('.ad-menu .ui-menu-item')];
}

describe('DevicesPanel layout', () => {
  function sshSection(): HTMLElement {
    return host.querySelector<HTMLElement>('section.re, section.re-page')!;
  }

  function visibleTabs(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((tab) => tab.closest<HTMLElement>('section.ad, section.re')?.style.display !== 'none');
  }

  it('shows this device above tabs for my devices and SSH devices, and only the SSH page while it is open', async () => {
    mountPanel({ thisDevice: true, devices: [sshDevice('devbox')] });
    await flush();
    expect([...host.querySelectorAll('h3')].map((title) => title.textContent)).toEqual(['This computer']);
    expect(host.querySelector('.this-device-probe')?.textContent).toBe('Remote Control');
    expect(visibleTabs().map((tab) => tab.textContent?.trim())).toEqual(['My devices', 'SSH devices 1']);
    expect(host.querySelector<HTMLElement>('.ad')!.style.display).toBe('');
    expect(sshSection().style.display).toBe('none');

    visibleTabs()[1]!.click();
    await nextTick();
    expect(host.querySelector<HTMLElement>('.ad')!.style.display).toBe('none');
    expect(sshSection().style.display).toBe('');

    await openRowEditor();
    expect(host.querySelector<HTMLElement>('.dp-this-device')!.style.display).toBe('none');
    expect(host.querySelector('section.re-page')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.re-back')!.click();
    await nextTick();
    expect(host.querySelector<HTMLElement>('.dp-this-device')!.style.display).toBe('');
    expect(sshSection().style.display).toBe('');
  });

  it('leaves out this device when the app has nothing to show for it', async () => {
    mountPanel();
    await flush();
    expect(host.querySelector('.dp-this-device')).toBeNull();
    expect(host.querySelectorAll('h3')).toHaveLength(0);
    expect(visibleTabs().map((tab) => tab.textContent?.trim())).toEqual(['My devices', 'SSH devices']);
  });

  it('marks the tab that has a device with a problem', async () => {
    mountPanel({
      devices: [sshDevice('devbox', { status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' })],
    });
    await flush();
    const [account, ssh] = visibleTabs();
    expect(account!.querySelector('.ui-seg__swatch')).toBeNull();
    expect(ssh!.querySelector('.ui-seg__swatch')).not.toBeNull();
  });
});

describe('DevicesPanel my devices', () => {
  it('asks to sign in before listing other devices', async () => {
    const onLogin = vi.fn();
    const { loadRegistrations } = mountPanel({ onLogin });
    await flush();

    expect(host.querySelector('.ad-center-title')?.textContent).toBe('Sign in to see your other devices');
    expect(host.querySelector('.ad-log-in')?.textContent?.trim()).toBe('Sign in');
    host.querySelector<HTMLButtonElement>('.ad-log-in')!.click();
    expect(onLogin).toHaveBeenCalledOnce();
    expect(loadRegistrations).not.toHaveBeenCalled();
  });

  it('loads the account devices once signed in and says when this computer is the only one', async () => {
    const { loadRegistrations } = mountPanel({ signedIn: true, registrations: [registration('this-mac')], maxDevices: 3 });
    await flush();

    expect(loadRegistrations).toHaveBeenCalledOnce();
    expect(host.querySelector('.ad-empty')?.textContent).toContain('or run kimi rc on a server');
    expect(host.querySelector('.ad-usage')).toBeNull();
    expect(host.querySelector('.ad-row')).toBeNull();
  });

  it('mentions the device limit only once the account has reached it', async () => {
    mountPanel({
      signedIn: true,
      registrations: [registration('this-mac'), registration('rc-mac', { alias: 'Work Mac' }), registration('rc-pc', { alias: 'Gaming PC' })],
      maxDevices: 3,
    });
    await flush();

    expect(host.querySelector('.ad-usage')?.textContent).toBe('Device limit reached (3)');
  });

  it('describes each device and adds it to or removes it from the sidebar', async () => {
    const { addAccountDevice, remove } = mountPanel({
      signedIn: true,
      devices: [{ id: 'rc-pc', connection: 'account', status: 'ready', alias: 'Gaming PC' }],
      registrations: [
        registration('rc-mac', { alias: 'Work Mac' }),
        registration('rc-pc', { alias: 'Gaming PC', platform: 'win32', client_version: 'kimi-code-cli/1.2.0' }),
      ],
    });
    await flush();

    expect(statusParts('Work Mac')).toEqual(['Online']);
    expect(statusParts('Gaming PC')).toEqual(['Connected']);
    const toggle = (name: string) => accountRow(name).querySelector<HTMLButtonElement>('.ui-switch')!;
    expect(toggle('Work Mac').getAttribute('aria-checked')).toBe('false');
    expect(toggle('Work Mac').getAttribute('aria-label')).toBe('Enable Work Mac');
    expect(toggle('Gaming PC').getAttribute('aria-checked')).toBe('true');

    toggle('Work Mac').click();
    await vi.waitFor(() => expect(addAccountDevice).toHaveBeenCalledExactlyOnceWith('rc-mac'));
    await flush();
    expect(toggle('Work Mac').getAttribute('aria-checked')).toBe('true');

    toggle('Gaming PC').click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('rc-pc'));
    await flush();
    expect(toggle('Gaming PC').getAttribute('aria-checked')).toBe('false');
  });

  it('shows why an added device cannot connect', async () => {
    mountPanel({
      signedIn: true,
      devices: [{ id: 'rc-mac', connection: 'account', status: 'disconnected', connectError: 'old', connectFailure: 'outdated', alias: 'Work Mac' }],
      registrations: [registration('rc-mac', { alias: 'Work Mac', client_version: 'kimi-code-desktop/1.0.0' })],
    });
    await flush();

    expect(statusParts('Work Mac')).toEqual(['Outdated', 'Update Kimi Code on Work Mac, then reconnect']);
  });

  it('tells how to bring an offline command-line device back', async () => {
    mountPanel({
      signedIn: true,
      registrations: [
        registration('rc-box', { alias: 'Build box', status: 'offline', platform: 'linux', client_version: 'kimi-code-cli/1.2.0' }),
        registration('rc-mac', { alias: 'Work Mac', status: 'offline' }),
      ],
    });
    await flush();

    expect(statusParts('Build box')).toEqual(['Offline', 'Run kimi rc on that machine']);
    expect(statusParts('Work Mac')).toEqual(['Offline']);
  });

  it('reconnects a device that failed to connect from its row', async () => {
    const { connect } = mountPanel({
      signedIn: true,
      devices: [{ id: 'rc-mac', connection: 'account', status: 'disconnected', connectError: 'relay closed', connectFailure: 'relay_unavailable', alias: 'Work Mac' }],
      registrations: [registration('rc-mac', { alias: 'Work Mac' })],
    });
    await flush();

    accountRow('Work Mac').querySelector<HTMLButtonElement>('.ad-reconnect')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith('rc-mac'));
  });

  it('leaves out a machine that is used over SSH until that SSH device is turned off', async () => {
    const { store } = mountPanel({
      signedIn: true,
      devices: [sshDevice('devbox', { status: 'ready', deviceId: 'rc-server', name: 'Dev box' })],
      registrations: [registration('rc-server', { alias: 'Server', platform: 'linux' }), registration('rc-mac', { alias: 'Work Mac' })],
    });
    await flush();
    expect(accountRowNames()).toEqual(['Work Mac']);

    store.byId = { devbox: sshDevice('devbox', { enabled: false, deviceId: 'rc-server', name: 'Dev box' }) };
    await flush();
    expect(accountRowNames()).toEqual(['Server', 'Work Mac']);
    expect(accountRow('Server').querySelector<HTMLButtonElement>('.ui-switch')!.disabled).toBe(false);
  });

  it('folds devices that have been offline for a long time', async () => {
    mountPanel({
      signedIn: true,
      registrations: [
        registration('rc-old', { alias: 'Old laptop', status: 'offline', updated_at: '2026-01-01T00:00:00.000Z' }),
        registration('rc-mac', { alias: 'Work Mac' }),
        registration('rc-pc', { alias: 'Gaming PC', status: 'offline' }),
      ],
    });
    await flush();

    expect(accountRowNames()).toEqual(['Work Mac', 'Gaming PC']);
    const fold = host.querySelector<HTMLButtonElement>('.ad-fold')!;
    expect(fold.textContent).toContain('1 devices offline for more than 7 days');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fold.click();
    await nextTick();
    expect(accountRowNames()).toEqual(['Work Mac', 'Gaming PC', 'Old laptop']);
  });

  it('explains how to add devices when every listed device has been offline for a long time', async () => {
    mountPanel({
      signedIn: true,
      registrations: [registration('rc-old', { alias: 'Old laptop', status: 'offline', updated_at: '2026-01-01T00:00:00.000Z' })],
    });
    await flush();

    expect(host.querySelector('.ad-card .ad-empty')?.textContent).toContain('or run kimi rc on a server');
    expect(host.querySelector('.ad-fold')?.textContent).toContain('1 devices offline for more than 7 days');
    expect(host.querySelector('section.ad [role="tab"]')?.textContent?.trim()).toBe('My devices');
  });

  it('renames, takes offline and deletes devices from the account through the row menu', async () => {
    const createProject = vi.fn();
    const { renameRegistration, deactivateRegistration, deleteRegistration } = mountPanel({
      signedIn: true,
      createProject,
      devices: [{ id: 'rc-mac', connection: 'account', status: 'ready', alias: 'Work Mac' }],
      registrations: [registration('rc-mac', { alias: 'Work Mac' }), registration('rc-old', { alias: 'Old laptop', status: 'offline' })],
    });
    await flush();

    let items = await openAccountMenu('Work Mac');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['New project', 'Reconnect', 'Rename', 'Take offline']);
    items[0]!.click();
    expect(createProject).toHaveBeenCalledExactlyOnceWith('rc-mac');

    items = await openAccountMenu('Work Mac');
    items[2]!.click();
    await flush();
    const input = host.querySelector<HTMLInputElement>('.ad-rename input')!;
    expect(input.value).toBe('Work Mac');
    input.value = 'Studio';
    input.dispatchEvent(new Event('input'));
    host.querySelector<HTMLFormElement>('.ad-rename')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(renameRegistration).toHaveBeenCalledExactlyOnceWith('rc-mac', 'Studio'));
    await flush();
    expect(host.querySelector('.ad-rename')).toBeNull();

    items = await openAccountMenu('Work Mac');
    items[3]!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.title).toBe('Take Work Mac offline'));
    await useConfirmDialog().runAction();
    expect(deactivateRegistration).toHaveBeenCalledExactlyOnceWith('rc-mac');

    items = await openAccountMenu('Old laptop');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Rename', 'Delete']);
    items[1]!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.title).toBe('Delete Old laptop'));
    await useConfirmDialog().runAction();
    expect(deleteRegistration).toHaveBeenCalledExactlyOnceWith('rc-old');
  });

  it('reports a device that could not be added', async () => {
    const { addAccountDevice } = mountPanel({ signedIn: true, registrations: [registration('rc-mac', { alias: 'Work Mac' })] });
    addAccountDevice.mockRejectedValueOnce(new Error('validation failed'));
    await flush();

    accountRow('Work Mac').querySelector<HTMLButtonElement>('.ui-switch')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ad-error')?.textContent).toBe("Couldn't save. Please try again"));
    expect(accountRow('Work Mac').querySelector('.ui-switch')!.getAttribute('aria-checked')).toBe('false');
  });
});

describe('DevicesPanel upgrades', () => {
  function sshRow(id: string): HTMLElement {
    return [...host.querySelectorAll<HTMLElement>('.re-item')].find((item) => item.querySelector('.re-row-name')?.textContent === id)!;
  }

  function sshStatus(id: string): string[] {
    return [...sshRow(id).querySelectorAll('.re-row-state, .re-row-detail')].map((node) => node.textContent?.trim() ?? '');
  }

  async function toggleSshMenu(id: string): Promise<string[]> {
    sshRow(id).querySelector<HTMLButtonElement>('.re-row-more')!.click();
    await flush();
    return [...host.querySelectorAll('.re-row-menu .ui-menu-item')].map((item) => item.textContent?.trim() ?? '');
  }

  function menuTexts(items: HTMLButtonElement[]): (string | undefined)[] {
    return items.map((item) => item.textContent?.trim());
  }

  async function closeMenu(): Promise<void> {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() => expect(host.querySelector('.ad-menu, .re-row-menu')).toBeNull());
  }

  it('upgrades an outdated account device from its row and shows the upgrade on its status line', async () => {
    const outdated: AppDevice = { id: 'rc-box', connection: 'account', status: 'disconnected', connectError: 'old', connectFailure: 'outdated', alias: 'Build box', install: 'cli', remoteUpgrade: true };
    const { store } = mountPanel({
      signedIn: true,
      devices: [outdated],
      registrations: [
        registration('rc-box', { alias: 'Build box', platform: 'linux', client_version: 'kimi-code-cli/1.0.0' }),
        registration('rc-mac', { alias: 'Work Mac', client_version: 'kimi-code-cli/1.0.0' }),
      ],
    });
    const upgrade = vi.spyOn(store, 'upgrade').mockResolvedValue();
    await flush();

    expect(statusParts('Build box')).toEqual(['Outdated']);
    expect(accountRow('Work Mac').querySelector('.ad-upgrade')).toBeNull();
    expect(menuTexts(await openAccountMenu('Work Mac'))).toEqual(['Rename', 'Take offline']);
    await closeMenu();
    expect(menuTexts(await openAccountMenu('Build box'))).toEqual(['Reconnect', 'Rename', 'Take offline']);
    await closeMenu();
    accountRow('Build box').querySelector<HTMLButtonElement>('.ad-upgrade')!.click();
    expect(upgrade).toHaveBeenCalledExactlyOnceWith('rc-box');

    store.byId = { 'rc-box': { ...outdated, upgradeStatus: 'installing' } };
    await flush();
    expect(statusParts('Build box')).toEqual(['Upgrading…']);
    expect(accountRow('Build box').querySelector('.kw-dot--running')).not.toBeNull();
    expect(accountRow('Build box').querySelector('.ad-upgrade')).toBeNull();
    expect(menuTexts(await openAccountMenu('Build box'))).not.toContain('Upgrade Kimi Code');
    await closeMenu();

    store.byId = { 'rc-box': { ...outdated, status: 'connecting', upgradeStatus: 'restarting' } };
    await flush();
    expect(statusParts('Build box')[0]).toBe('Restarting…');

    store.byId = { 'rc-box': { ...outdated, upgradeStatus: 'failed', upgradeError: 'installer exited with 1\nsee the log' } };
    await flush();
    expect(statusParts('Build box')).toEqual(['Upgrade failed', 'installer exited with 1']);
    expect(accountRow('Build box').querySelector('.ad-status--upgrade-failed .kw-dot--error')).not.toBeNull();
  });

  it('keeps a connection problem on the status line after an upgrade that could not help', async () => {
    const busy = sshDevice('devbox', {
      status: 'disconnected',
      connectError: 'a kimi server of version 2.6.3 is still running work on this device; retry after it finishes',
      connectFailure: 'remote_busy',
      remoteUpgrade: true,
      upgradeStatus: 'failed',
      upgradeError: 'Kimi Code is already up to date (v2.7.0).',
    });
    mountPanel({ devices: [busy] });
    await flush();

    expect(sshStatus('devbox')[0]).toBe('Connection failed');
    expect(sshStatus('devbox').join(' ')).not.toContain('already up to date');
    expect(sshRow('devbox').querySelector('.re-row-action')).not.toBeNull();
    expect(sshRow('devbox').querySelector('.re-row-upgrade')).toBeNull();
    expect(await toggleSshMenu('devbox')).not.toContain('Upgrade Kimi Code');
  });

  it('upgrades an outdated SSH device from its row and shows the upgrade on its status line', async () => {
    const outdated = sshDevice('devbox', { status: 'disconnected', connectError: 'old', connectFailure: 'outdated', remoteVersion: '0.40.0', remoteUpgrade: true });
    const { store } = mountPanel({ devices: [outdated, sshDevice('paused', { enabled: false, remoteUpgrade: true })] });
    const upgrade = vi.spyOn(store, 'upgrade').mockResolvedValue();
    await flush();

    expect(sshRow('paused').querySelector('.re-row-upgrade')).toBeNull();
    expect(await toggleSshMenu('paused')).not.toContain('Upgrade Kimi Code');
    await closeMenu();
    expect(await toggleSshMenu('devbox')).not.toContain('Upgrade Kimi Code');
    await closeMenu();
    sshRow('devbox').querySelector<HTMLButtonElement>('.re-row-upgrade')!.click();
    expect(upgrade).toHaveBeenCalledExactlyOnceWith('devbox');

    store.byId = { ...store.byId, devbox: { ...outdated, upgradeStatus: 'installing' } };
    await flush();
    expect(sshStatus('devbox')).toEqual(['Upgrading…']);
    expect(sshRow('devbox').querySelector('.re-row-details')).toBeNull();
    expect(sshRow('devbox').querySelector('.re-row-upgrade')).toBeNull();
    expect(await toggleSshMenu('devbox')).not.toContain('Upgrade Kimi Code');
    await closeMenu();

    store.byId = { ...store.byId, devbox: { ...outdated, upgradeStatus: 'failed', upgradeError: 'permission denied\nat step 2' } };
    await flush();
    expect(sshStatus('devbox')).toEqual(['Upgrade failed', 'permission denied']);
    expect(sshRow('devbox').querySelector('.re-row-status--upgrade-failed .kw-dot--error')).not.toBeNull();
    expect(sshRow('devbox').querySelector('.re-row-upgrade')).not.toBeNull();
  });
});
