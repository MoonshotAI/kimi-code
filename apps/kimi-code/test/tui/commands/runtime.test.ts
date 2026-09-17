import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionRuntimesInfo } from '@moonshot-ai/kimi-code-sdk';

import { handleRuntimeCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { RuntimeAddDialogComponent } from '#/tui/components/dialogs/runtime-add-dialog';
import { RuntimeCwdDialogComponent } from '#/tui/components/dialogs/runtime-cwd-dialog';
import { RuntimeManagerComponent } from '#/tui/components/dialogs/runtime-manager';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';

const ENTER = '\r';
const DOWN = '[B';
const TAB = '\t';

interface MountedPanel {
  handleInput(data: string): void;
}

function makeRuntimesInfo(overrides: Partial<SessionRuntimesInfo> = {}): SessionRuntimesInfo {
  return {
    workspaceId: 'ws-1',
    runtimes: [
      { runtimeId: 'local', type: 'local', status: 'ready', generation: 'g0', capabilities: ['fs', 'process'] },
      {
        runtimeId: 'dev-box',
        type: 'ssh',
        status: 'ready',
        generation: 'g1',
        capabilities: ['fs', 'process'],
        defaultCwd: '/home/me/projects',
      },
      { runtimeId: 'sandbox', type: 'command', status: 'disconnected', generation: 'g2', capabilities: [] },
    ],
    sshHosts: ['dev-box', 'staging'],
    ...overrides,
  };
}

function makeHost(options: {
  list?: SessionRuntimesInfo;
  currentRuntimeId?: string;
  switchError?: Error;
  reconnectError?: Error;
  setConfigError?: Error;
  registrationDelayCalls?: number;
}) {
  let currentList = options.list ?? makeRuntimesInfo();
  // Simulate the engine's declaration watch: once setConfig writes a
  // [runtimes] entry, listRuntimes includes the new runtime — after
  // `registrationDelayCalls` polls, to mimic the async reconcile.
  let callsAfterAdd = -1;
  let pending: SessionRuntimesInfo['runtimes'][number] | undefined;
  const session = {
    id: 'ses-1',
    listRuntimes: vi.fn(async () => {
      if (callsAfterAdd >= 0) callsAfterAdd += 1;
      if (pending !== undefined && callsAfterAdd > (options.registrationDelayCalls ?? 0)) {
        currentList = { ...currentList, runtimes: [...currentList.runtimes, pending] };
        pending = undefined;
      }
      return currentList;
    }),
    getRuntime: vi.fn(async () => ({ workspaceId: 'ws-1', runtimeId: options.currentRuntimeId ?? 'local' })),
    switchRuntime: vi.fn(async (runtimeId: string, opts?: { cwd?: string }) => {
      if (options.switchError !== undefined) throw options.switchError;
      return { workspaceId: 'ws-1', runtimeId, cwd: opts?.cwd };
    }),
    reconnectRuntime: vi.fn(async () => {
      if (options.reconnectError !== undefined) throw options.reconnectError;
      return { workspaceId: 'ws-1', runtimeId: options.currentRuntimeId ?? 'local' };
    }),
  };
  const mounted: MountedPanel[] = [];
  const host = {
    state: { appState: { model: 'test-model' } },
    session: session as unknown as Session,
    requireSession: () => session as unknown as Session,
    harness: {
      setConfig: vi.fn(async (patch: unknown) => {
        if (options.setConfigError !== undefined) throw options.setConfigError;
        callsAfterAdd = 0;
        const declared = (patch as { runtimes?: Record<string, { type?: string; defaultCwd?: string }> }).runtimes ?? {};
        for (const [id, entry] of Object.entries(declared)) {
          pending = {
            runtimeId: id,
            type: entry.type ?? 'command',
            status: 'disconnected',
            generation: `g-${id}`,
            capabilities: [],
            defaultCwd: entry.defaultCwd,
          } as unknown as SessionRuntimesInfo['runtimes'][number];
        }
        return patch;
      }),
    },
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    refreshRuntimeSlot: vi.fn(async () => {}),
  } as unknown as SlashCommandHost;
  return { host, session, mounted, list: currentList };
}

function latest<T>(mounted: MountedPanel[], type: new (...args: never[]) => T): T {
  const panel = mounted.toReversed().find((p) => p instanceof type);
  if (panel === undefined) throw new Error(`no mounted panel of type ${type.name}`);
  return panel as T;
}

function typeText(panel: MountedPanel, text: string): void {
  for (const char of text) panel.handleInput(char);
}

describe('handleRuntimeCommand', () => {
  it('mounts the manager with the fetched runtime list and binding', async () => {
    const { host, session, mounted } = makeHost({});
    await handleRuntimeCommand(host);

    expect(session.listRuntimes).toHaveBeenCalledTimes(1);
    const manager = latest(mounted, RuntimeManagerComponent);
    const plain = manager.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('dev-box');
    expect(plain).toContain('sandbox');
    expect(plain).toContain('← current');
  });

  it('switches to a remote runtime through the cwd dialog', async () => {
    const { host, session, mounted } = makeHost({});
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER);

    const dialog = latest(mounted, RuntimeCwdDialogComponent);
    dialog.handleInput(ENTER); // accept the prefilled defaultCwd
    await vi.waitFor(() => {
      expect(session.switchRuntime).toHaveBeenCalledWith('dev-box', { cwd: '/home/me/projects' });
    });
    await vi.waitFor(() => {
      expect(host.restoreEditor).toHaveBeenCalled();
    });
    expect(host.refreshRuntimeSlot).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Runtime switched to dev-box.');
  });

  it('keeps handshake or validation failures inline in the cwd dialog', async () => {
    const { host, mounted } = makeHost({
      switchError: new Error('handshake failed: exit code 127\nkimi: command not found'),
    });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER);
    const dialog = latest(mounted, RuntimeCwdDialogComponent);
    dialog.handleInput(ENTER);
    await vi.waitFor(() => {
      const plain = dialog.render(100).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('handshake failed: exit code 127');
    });
    expect(host.restoreEditor).not.toHaveBeenCalled();
  });

  it('switches to local directly without a cwd prompt', async () => {
    const { host, session, mounted } = makeHost({ currentRuntimeId: 'dev-box' });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    // Selection starts on the current (dev-box) row; local sits above it.
    manager.handleInput('[A');
    manager.handleInput(ENTER);
    await vi.waitFor(() => {
      expect(session.switchRuntime).toHaveBeenCalledWith('local', undefined);
    });
    expect(mounted.some((p) => p instanceof RuntimeCwdDialogComponent)).toBe(false);
    await vi.waitFor(() => {
      expect(host.restoreEditor).toHaveBeenCalled();
    });
  });

  it('reconnects the bound disconnected runtime on R and refreshes the list', async () => {
    const { host, session, mounted } = makeHost({ currentRuntimeId: 'sandbox' });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput('r');
    await vi.waitFor(() => {
      expect(session.reconnectRuntime).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(host.refreshRuntimeSlot).toHaveBeenCalled();
    });
    expect(session.listRuntimes).toHaveBeenCalledTimes(2);
  });

  it('shows a reconnect failure inline in the manager', async () => {
    const { host, mounted } = makeHost({
      currentRuntimeId: 'sandbox',
      reconnectError: new Error('ssh exited 255'),
    });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput('r');
    await vi.waitFor(() => {
      const plain = manager.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('ssh exited 255');
    });
    expect(host.restoreEditor).not.toHaveBeenCalled();
  });

  it('adds an ssh runtime from a discovery candidate through the full form flow', async () => {
    const { host, mounted } = makeHost({});
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER); // [ Add Runtime ]

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof ChoicePickerComponent)).toBe(true);
    });
    const typePicker = latest(mounted, ChoicePickerComponent);
    typePicker.handleInput(ENTER); // first option: SSH host

    await vi.waitFor(() => {
      expect(mounted.filter((p) => p instanceof ChoicePickerComponent).length).toBe(2);
    });
    const hostPicker = latest(mounted, ChoicePickerComponent);
    hostPicker.handleInput(DOWN); // 'staging' — not an existing runtime id
    hostPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof RuntimeAddDialogComponent)).toBe(true);
    });
    const form = latest(mounted, RuntimeAddDialogComponent);
    form.handleInput(TAB); // id (empty -> derives from host)
    form.handleInput(TAB); // defaultCwd
    typeText(form, '/home/me/projects');
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.harness.setConfig).toHaveBeenCalledWith({
        runtimes: { staging: { type: 'ssh', host: 'staging', defaultCwd: '/home/me/projects' } },
      });
    });
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Runtime "staging" added to config.toml.');
    });
    // The watch-driven registration lands before the manager reopens, so the
    // new runtime is listed immediately.
    await vi.waitFor(() => {
      const reopened = latest(mounted, RuntimeManagerComponent);
      const plain = reopened.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('staging');
    });
  });

  it('waits for a delayed watch registration before reopening the manager', async () => {
    const { host, mounted } = makeHost({ registrationDelayCalls: 2 });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER); // [ Add Runtime ]

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof ChoicePickerComponent)).toBe(true);
    });
    const typePicker = latest(mounted, ChoicePickerComponent);
    typePicker.handleInput(ENTER); // first option: SSH host

    await vi.waitFor(() => {
      expect(mounted.filter((p) => p instanceof ChoicePickerComponent).length).toBe(2);
    });
    const hostPicker = latest(mounted, ChoicePickerComponent);
    hostPicker.handleInput(DOWN); // 'staging' — not an existing runtime id
    hostPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof RuntimeAddDialogComponent)).toBe(true);
    });
    const form = latest(mounted, RuntimeAddDialogComponent);
    form.handleInput(TAB); // id (empty -> derives from host)
    form.handleInput(TAB); // defaultCwd
    typeText(form, '/home/me/projects');
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Runtime "staging" added to config.toml.');
    });
    await vi.waitFor(() => {
      const reopened = latest(mounted, RuntimeManagerComponent);
      const plain = reopened.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('staging');
    });
  });

  it('keeps engine validation failures inline in the add form', async () => {
    const { host, mounted } = makeHost({
      setConfigError: new Error('runtimes section is invalid'),
    });
    await handleRuntimeCommand(host);

    const manager = latest(mounted, RuntimeManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof ChoicePickerComponent)).toBe(true);
    });
    const typePicker = latest(mounted, ChoicePickerComponent);
    typePicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.filter((p) => p instanceof ChoicePickerComponent).length).toBe(2);
    });
    const hostPicker = latest(mounted, ChoicePickerComponent);
    hostPicker.handleInput(DOWN); // 'staging' — not an existing runtime id
    hostPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof RuntimeAddDialogComponent)).toBe(true);
    });
    const form = latest(mounted, RuntimeAddDialogComponent);
    form.handleInput(TAB);
    form.handleInput(TAB);
    form.handleInput(ENTER);
    await vi.waitFor(() => {
      const plain = form.render(100).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('runtimes section is invalid');
    });
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
