// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import WorkspaceEditDialog from '../src/dialogs/WorkspaceEditDialog.vue';
import type { AppDevice } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { devicesStore } from '@moonshot-ai/app-client/stores';



let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  setKimiClientDeps({
    api: () => ({ listDeviceSshConfig: async () => ({ configPath: '', exists: false, hosts: [] }) }) as never,
    t: (key) => key,
  });
  host = document.createElement('div');
  document.body.append(host);
  devicesStore().byId = {};
  devicesStore().loaded = true;
  devicesStore().connecting = {};
});

afterEach(() => {
  app?.unmount();
  app = null;
  resetKimiClientDeps();
  host.remove();
  document.body.innerHTML = '';
});

interface MountOptions {
  mode?: 'create' | 'edit';
  initialName?: string;
  initialDirs?: string[];
  initialDeviceId?: string;
  pick?: () => Promise<string[]>;
  pickRemote?: (deviceId: string, path: string) => Promise<string[]>;
  devices?: AppDevice[];
  manageDevices?: () => void;
  importProjectConfig?: (primary: string, deviceId?: string) => Promise<string[] | undefined>;
  busy?: boolean;
}

function mountDialog(opts: MountOptions = {}) {
  const submit = vi.fn();
  const cancel = vi.fn();
  app = createApp({
    render: () =>
      h(WorkspaceEditDialog, {
        mode: opts.mode ?? 'create',
        initialName: opts.initialName,
        initialDirs: opts.initialDirs,
        initialDeviceId: opts.initialDeviceId,
        pick: opts.pick ?? (async () => []),
        pickRemote: opts.pickRemote,
        devices: opts.devices,
        manageDevices: opts.manageDevices,
        importProjectConfig: opts.importProjectConfig,
        busy: opts.busy,
        onSubmit: submit,
        onCancel: cancel,
      }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  return { submit, cancel };
}

function sshDevice(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: `${id}.example.test`, status: 'pending', ...extra };
}

function accountDevice(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'account', status: 'pending', ...extra };
}

function nameInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.ui-dialog .ui-input');
  expect(el).not.toBeNull();
  return el!;
}

function dirRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.we-dir-row')];
}

function primaryRow(): HTMLElement | undefined {
  return dirRows().find((row) => row.querySelector('.we-dir-badge') !== null);
}

function submitButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('.ui-dialog__foot .ui-button--primary');
  expect(el).not.toBeNull();
  return el!;
}

async function setName(value: string): Promise<void> {
  const input = nameInput();
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await nextTick();
}

describe('WorkspaceEditDialog create mode', () => {
  it('prefills the name from the first picked directory', async () => {
    mountDialog({ initialDirs: ['/Users/x/project', '/Users/x/lib'] });
    await nextTick();
    expect(nameInput().value).toBe('project');
    expect(dirRows()).toHaveLength(2);
    expect(primaryRow()?.textContent).toContain('project');
    expect(dirRows()[0]?.querySelector('.we-dir-name')?.classList.contains('we-dir-name--with-device')).toBe(false);
  });

  it('shows a device by its name instead of its id', async () => {
    mountDialog({ devices: [sshDevice('device-a1b2c3d4', { name: 'Build box' })], initialDeviceId: 'device-a1b2c3d4' });
    await nextTick();
    const drop = document.querySelector('.we-drop')?.textContent ?? '';
    expect(drop).toContain('Build box');
    expect(drop).not.toContain('device-a1b2c3d4');
    expect(document.querySelector('.we-source-select')?.textContent).toContain('Build box');
  });

  it('keeps unconfigured SSH aliases out of the project source list', async () => {
    setKimiClientDeps({
      api: () => ({
        listDeviceSshConfig: async () => ({ configPath: '/home/me/.ssh/config', exists: true, hosts: [{ alias: 'test', hostName: 'example.test', user: 'dev', port: 22 }] }),
        connectDevice: async (id: string) => sshDevice(id, { status: 'ready' }),
      }) as never,
      t: (key) => key,
    });
    const manageDevices = vi.fn();
    devicesStore().byId = {
      test: sshDevice('test', { status: 'ready' }),
      paused: sshDevice('paused', { enabled: false }),
      broken: sshDevice('broken', { status: 'disconnected', connectError: 'Connection refused' }),
    };
    mountDialog({ devices: Object.values(devicesStore().byId), manageDevices });
    await nextTick();

    document.querySelector<HTMLButtonElement>('button.we-source-select')!.click();
    await nextTick();
    const options = [...document.querySelectorAll<HTMLButtonElement>('.ui-select__option')];
    expect(options).toHaveLength(5);
    expect(options[1]?.textContent).toContain('test.example.test');
    expect(options[2]?.textContent).toContain('paused');
    expect(options[3]?.textContent).toContain('broken');
    expect(options.some((option) => option.textContent?.includes('dev@example.test'))).toBe(false);
    expect(options.map((option) => option.disabled)).toEqual([false, false, true, true, false]);
    options[4]!.click();
    await nextTick();
    expect(manageDevices).toHaveBeenCalledOnce();
  });

  it('offers account devices by their alias and platform and keeps offline ones unselectable', async () => {
    devicesStore().byId = {
      'rc-mac': accountDevice('rc-mac', { status: 'ready', alias: 'Work Mac', platform: 'darwin' }),
      'rc-pc': accountDevice('rc-pc', { status: 'disconnected', connectError: 'offline', connectFailure: 'offline', alias: 'Gaming PC', platform: 'win32' }),
    };
    mountDialog({ devices: Object.values(devicesStore().byId), manageDevices: vi.fn() });
    await nextTick();

    document.querySelector<HTMLButtonElement>('button.we-source-select')!.click();
    await nextTick();
    const options = [...document.querySelectorAll<HTMLButtonElement>('.ui-select__option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'This computer',
      expect.stringContaining('Work Mac'),
      expect.stringContaining('Gaming PC'),
      'Manage devices',
    ]);
    expect(options[1]?.textContent).toContain('macOS · Connected');
    expect(options[2]?.textContent).toContain('Windows · Offline');
    expect(options.map((option) => option.disabled)).toEqual([false, false, true, false]);
  });

  it('keeps the same device field when no SSH devices exist', async () => {
    const manageDevices = vi.fn();
    mountDialog({ manageDevices });
    await nextTick();

    const select = document.querySelector<HTMLButtonElement>('button.we-source-select');
    expect(select).not.toBeNull();
    select!.click();
    await nextTick();
    const options = [...document.querySelectorAll<HTMLButtonElement>('.ui-select__option')];
    expect(options).toHaveLength(2);
    const sourceLabel = select!.textContent;
    options[1]!.click();
    await nextTick();
    expect(manageDevices).toHaveBeenCalledOnce();
    expect(select!.textContent).toBe(sourceLabel);
  });

  it('does not preselect a device that failed to connect', async () => {
    const broken = sshDevice('broken', { status: 'disconnected', connectError: 'Connection refused' });
    devicesStore().byId = { broken };
    mountDialog({ devices: [broken], initialDeviceId: 'broken', manageDevices: vi.fn() });
    await nextTick();

    expect(document.querySelector('button.we-source-select')?.textContent).not.toContain('broken');
  });

  it('appends picked directories with dedupe and keeps a user-edited name', async () => {
    let round = 0;
    const pick = vi.fn(async () => {
      round += 1;
      return round === 1 ? ['/a/first', '/a/second'] : ['/a/second', '/a/third'];
    });
    mountDialog({ pick });
    await nextTick();

    document.querySelector<HTMLButtonElement>('.we-add-directory')!.click();
    await nextTick();
    await nextTick();
    expect(dirRows()).toHaveLength(2);
    expect(nameInput().value).toBe('first');

    await setName('my workspace');
    document.querySelector<HTMLButtonElement>('.we-add-directory')!.click();
    await nextTick();
    await nextTick();

    expect(dirRows()).toHaveLength(3);
    expect(nameInput().value).toBe('my workspace');
    const names = [...document.querySelectorAll('.we-dir-name')];
    expect(names.map((el) => el.textContent)).toEqual(['first', 'second', 'third']);
    expect(names.every((el) => el.parentElement?.classList.contains('ui-tip') && !el.hasAttribute('title'))).toBe(true);
    expect(document.querySelector('.we-dir-path')).toBeNull();
  });

  it('shows the full directory path in a tooltip', async () => {
    mountDialog({ initialDirs: ['/a/first'] });
    await nextTick();
    const name = document.querySelector<HTMLElement>('.we-dir-name')!;
    vi.useFakeTimers();
    try {
      document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      name.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await nextTick();
    }
    expect(document.querySelector('.ui-tip__bubble')?.textContent).toBe('/a/first');
  });

  it('shows the full directory path when the directory name receives keyboard focus', async () => {
    mountDialog({ initialDirs: ['/a/first'] });
    await nextTick();
    const name = document.querySelector<HTMLElement>('.we-dir-name')!;
    expect(name.tabIndex).toBe(0);
    expect(name.getAttribute('aria-label')).toBe('/a/first');
    vi.useFakeTimers();
    try {
      name.focus();
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await nextTick();
    }
    expect(document.querySelector('.ui-tip__bubble')?.textContent).toBe('/a/first');
  });

  it('promotes the next directory to primary after removing the first one', async () => {
    mountDialog({ initialDirs: ['/a/first', '/a/second'] });
    await nextTick();
    expect(nameInput().value).toBe('first');

    const firstRemove = dirRows()[0]!.querySelector<HTMLButtonElement>('.we-dir-rm');
    expect(firstRemove).not.toBeNull();
    firstRemove!.click();
    await nextTick();

    expect(dirRows()).toHaveLength(1);
    expect(primaryRow()?.textContent).toContain('second');
    expect(nameInput().value).toBe('second');
  });

  it('disables submit while the name is blank', async () => {
    const { submit } = mountDialog({ initialDirs: ['/a/first'] });
    await nextTick();
    expect(submitButton().disabled).toBe(false);

    await setName('   ');
    expect(submitButton().disabled).toBe(true);
    submitButton().click();
    await nextTick();
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits the trimmed name and the ordered directory list', async () => {
    const { submit } = mountDialog({ initialDirs: ['/a/first', '/a/second'] });
    await nextTick();
    await setName('  my workspace  ');
    submitButton().click();
    await nextTick();
    expect(submit).toHaveBeenCalledWith({
      name: 'my workspace',
      dirs: ['/a/first', '/a/second'],
      projectConfigDirs: [],
    });
  });
});

describe('WorkspaceEditDialog edit mode', () => {
  it('allows adding and reordering directories for a project that lives on an SSH device', async () => {
    const pickRemote = vi.fn(async () => ['/home/dev/extra']);
    const { submit } = mountDialog({
      mode: 'edit',
      initialName: 'demo',
      initialDirs: ['/home/dev/demo'],
      initialDeviceId: 'dev',
      devices: [sshDevice('dev', { name: 'Dev box' })],
      pickRemote,
    });
    await nextTick();
    expect(dirRows()).toHaveLength(1);
    expect(dirRows()[0]?.textContent).toContain('Dev box');
    expect(dirRows()[0]?.querySelector('.we-dir-name')?.classList.contains('we-dir-name--with-device')).toBe(true);

    document.querySelector<HTMLButtonElement>('.we-add-directory')!.click();
    await vi.waitFor(() => expect(dirRows()).toHaveLength(2));
    expect(pickRemote).toHaveBeenCalledExactlyOnceWith('dev', '/home/dev/demo');

    dirRows()[1]!.querySelector<HTMLButtonElement>('.we-dir-primary')!.click();
    await nextTick();
    expect(document.activeElement).toBe(dirRows()[1]!.querySelector('.we-dir-primary'));
    expect(document.querySelector('.we-primary-status')).not.toBeNull();
    submitButton().click();
    await nextTick();
    expect(submit).toHaveBeenCalledWith({
      name: 'demo',
      dirs: ['/home/dev/extra', '/home/dev/demo'],
      deviceId: 'dev',
      projectConfigDirs: [],
    });
  });

  it('keeps the primary directory non-removable and allows removing additional ones', async () => {
    mountDialog({
      mode: 'edit',
      initialName: 'my workspace',
      initialDirs: ['/a/root', '/a/extra'],
    });
    await nextTick();

    const rows = dirRows();
    expect(rows).toHaveLength(2);
    expect(nameInput().value).toBe('my workspace');
    expect(rows[0]!.querySelector('.we-dir-badge')).not.toBeNull();
    expect(rows[0]!.querySelector('.ui-badge--outline')).not.toBeNull();
    expect(rows[0]!.querySelector('button.we-dir-rm')).toBeNull();
    expect(rows[1]!.querySelector<HTMLButtonElement>('.we-dir-rm')!.disabled).toBe(false);
  });

  it('submits the full directory list with the primary kept first', async () => {
    const { submit } = mountDialog({
      mode: 'edit',
      initialName: 'my workspace',
      initialDirs: ['/a/root', '/a/extra'],
    });
    await nextTick();

    dirRows()[1]!.querySelector<HTMLButtonElement>('.we-dir-rm')!.click();
    await nextTick();
    submitButton().click();
    await nextTick();
    expect(submit).toHaveBeenCalledWith({
      name: 'my workspace',
      dirs: ['/a/root'],
      projectConfigDirs: [],
    });
  });
});

describe('WorkspaceEditDialog shared behavior', () => {
  it('emits cancel from the footer button', async () => {
    const { cancel } = mountDialog({ initialDirs: ['/a/first'] });
    await nextTick();
    document.querySelector<HTMLButtonElement>('.ui-dialog__foot .ui-button--ghost')!.click();
    await nextTick();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('disables submit while busy', async () => {
    const { submit } = mountDialog({ initialDirs: ['/a/first'], busy: true });
    await nextTick();
    expect(submitButton().disabled).toBe(true);
    submitButton().click();
    await nextTick();
    expect(submit).not.toHaveBeenCalled();
  });

  it('locks directory edits until project config import finishes', async () => {
    let finishImport!: (dirs: string[]) => void;
    const { submit } = mountDialog({
      initialDirs: ['/a/root', '/a/second'],
      importProjectConfig: () => new Promise<string[]>((resolve) => {
        finishImport = resolve;
      }),
    });
    await nextTick();
    document.querySelector<HTMLButtonElement>('.we-dirs-actions .ui-button')!.click();
    await nextTick();

    const addButton = document.querySelector<HTMLButtonElement>('.we-add-directory')!;
    const remove = dirRows()[0]!.querySelector<HTMLButtonElement>('.we-dir-rm')!;
    const promote = dirRows()[1]!.querySelector<HTMLButtonElement>('.we-dir-primary')!;
    expect(addButton.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(promote.disabled).toBe(true);
    remove.click();
    promote.click();
    addButton.click();
    await nextTick();
    expect(dirRows()).toHaveLength(2);
    expect(primaryRow()?.textContent).toContain('root');

    finishImport(['/a/extra']);
    await vi.waitFor(() => expect(dirRows()).toHaveLength(3));
    submitButton().click();
    expect(submit).toHaveBeenCalledWith({
      name: 'root',
      dirs: ['/a/root', '/a/second', '/a/extra'],
      projectConfigDirs: ['/a/extra'],
    });
  });
});


describe('WorkspaceEditDialog remote directories', () => {
  it('appends multiple remote directories with dedupe', async () => {
    const pickRemote = vi.fn()
      .mockResolvedValueOnce(['/srv/one', '/srv/two'])
      .mockResolvedValueOnce(['/srv/two', '/srv/three']);
    const { submit } = mountDialog({
      initialDeviceId: 'devbox',
      devices: [sshDevice('devbox')],
      pickRemote,
    });
    await nextTick();

    document.querySelector<HTMLButtonElement>('.we-add-directory')!.click();
    await vi.waitFor(() => expect(dirRows()).toHaveLength(2));
    const addMore = document.querySelector<HTMLButtonElement>('.we-dirs-actions .we-add-directory')!;
    addMore.click();
    await vi.waitFor(() => expect(dirRows()).toHaveLength(3));
    expect(pickRemote.mock.calls).toEqual([
      ['devbox', ''],
      ['devbox', '/srv/one'],
    ]);

    submitButton().click();
    expect(submit).toHaveBeenCalledWith({
      name: 'one',
      dirs: ['/srv/one', '/srv/two', '/srv/three'],
      deviceId: 'devbox',
      projectConfigDirs: [],
    });
  });

  it('clears added directories when switching devices', async () => {
    mountDialog({
      initialDirs: ['/a/first', '/a/second'],
      devices: [sshDevice('devbox')],
      pickRemote: vi.fn(),
    });
    await nextTick();
    expect(dirRows()).toHaveLength(2);
    expect(nameInput().value).toBe('first');

    document.querySelector<HTMLButtonElement>('button.we-source-select')!.click();
    await nextTick();
    document.querySelectorAll<HTMLButtonElement>('.ui-select__option')[1]!.click();
    await nextTick();

    expect(dirRows()).toHaveLength(0);
    expect(nameInput().value).toBe('');
    expect(document.querySelector('.we-drop')?.textContent).toContain('devbox');
  });

  it('keeps local directories on this computer once they are added', async () => {
    const pick = vi.fn(async () => ['/a/root']);
    const pickRemote = vi.fn();
    mountDialog({
      initialDirs: ['/a/first'],
      devices: [sshDevice('devbox')],
      pick,
      pickRemote,
    });
    await nextTick();

    expect(document.querySelector('button.we-source-select')?.textContent).not.toContain('devbox');
    document.querySelector<HTMLButtonElement>('.we-dirs-actions .we-add-directory')!.click();
    await vi.waitFor(() => expect(dirRows()).toHaveLength(2));
    expect(pick).toHaveBeenCalledOnce();
    expect(pickRemote).not.toHaveBeenCalled();
  });

  it('imports remote project config and blocks submit while importing or disconnected', async () => {
    let finishImport!: (dirs: string[]) => void;
    const importProjectConfig = vi.fn(() => new Promise<string[]>((resolve) => { finishImport = resolve; }));
    const devbox = ref(sshDevice('devbox', { status: 'ready' }));
    const { submit } = mountDialog({
      mode: 'edit',
      initialName: 'app',
      initialDirs: ['/srv/app'],
      initialDeviceId: 'devbox',
      get devices() { return [devbox.value]; },
      importProjectConfig,
    });
    await nextTick();

    const importButton = [...document.querySelectorAll<HTMLButtonElement>('.we-dirs-actions button')]
      .find((button) => button.textContent?.includes('Import config'))!;
    importButton.click();
    await nextTick();
    expect(submitButton().disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.we-add-directory')!.disabled).toBe(true);
    submitButton().click();
    expect(submit).not.toHaveBeenCalled();

    finishImport(['/srv/shared']);
    await vi.waitFor(() => expect(dirRows()).toHaveLength(2));
    expect(importProjectConfig).toHaveBeenCalledExactlyOnceWith('/srv/app', 'devbox');
    devbox.value = sshDevice('devbox', { status: 'disconnected', connectError: 'Connection reset' });
    await nextTick();
    expect(submitButton().disabled).toBe(true);
    submitButton().click();
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows an inline error when the directory picker fails', async () => {
    mountDialog({ pick: async () => { throw new Error('cancelled'); } });
    await nextTick();

    document.querySelector<HTMLButtonElement>('.we-add-directory')!.click();
    await vi.waitFor(() => expect(document.querySelector('.we-pick-error')).not.toBeNull());
  });
});
