import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionEnvironmentsInfo } from '@moonshot-ai/kimi-code-sdk';

import { handleEnvironmentCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { EnvironmentAddDialogComponent } from '#/tui/components/dialogs/environment-add-dialog';
import { EnvironmentCwdDialogComponent } from '#/tui/components/dialogs/environment-cwd-dialog';
import { EnvironmentManagerComponent } from '#/tui/components/dialogs/environment-manager';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';

const ENTER = '\r';
const DOWN = '[B';
const TAB = '\t';

interface MountedPanel {
  handleInput(data: string): void;
}

function makeEnvironmentsInfo(overrides: Partial<SessionEnvironmentsInfo> = {}): SessionEnvironmentsInfo {
  return {
    environments: [
      { environmentId: 'local', type: 'local', status: 'ready' },
      {
        environmentId: 'dev-box',
        type: 'ssh',
        status: 'ready',
        defaultCwd: '/home/me/projects',
      },
      { environmentId: 'sandbox', type: 'command', status: 'disconnected' },
    ],
    sshHosts: ['dev-box', 'staging'],
    ...overrides,
  };
}

function makeHost(options: {
  list?: SessionEnvironmentsInfo;
  currentEnvironmentId?: string;
  switchError?: Error;
  reconnectError?: Error;
  declareError?: Error;
  declarationReady?: Promise<void>;
}) {
  let currentList = options.list ?? makeEnvironmentsInfo();
  const session = {
    id: 'ses-1',
    listEnvironments: vi.fn(async () => currentList),
    getEnvironment: vi.fn(async () => ({ environmentId: options.currentEnvironmentId ?? 'local' })),
    switchEnvironment: vi.fn(async (environmentId: string, opts?: { cwd?: string }) => {
      if (options.switchError !== undefined) throw options.switchError;
      return { environmentId, cwd: opts?.cwd };
    }),
    reconnectEnvironment: vi.fn(async () => {
      if (options.reconnectError !== undefined) throw options.reconnectError;
      return { environmentId: options.currentEnvironmentId ?? 'local' };
    }),
    declareEnvironment: vi.fn(
      async (input: { id: string; entry: { type?: string; defaultCwd?: string } }) => {
        if (options.declareError !== undefined) throw options.declareError;
        await options.declarationReady;
        const declared = {
          environmentId: input.id,
          type: input.entry.type ?? 'command',
          status: 'pending',
          generation: `g-${input.id}`,
          capabilities: [],
          defaultCwd: input.entry.defaultCwd,
        } as unknown as SessionEnvironmentsInfo['environments'][number];
        currentList = { ...currentList, environments: [...currentList.environments, declared] };
      },
    ),
  };
  const mounted: MountedPanel[] = [];
  const host = {
    state: { appState: { model: 'test-model' } },
    session: session as unknown as Session,
    requireSession: () => session as unknown as Session,
    harness: {},
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    refreshEnvironmentSlot: vi.fn(async () => {}),
    requestRender: vi.fn(),
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

async function openStagingAddForm(mounted: MountedPanel[]): Promise<EnvironmentAddDialogComponent> {
  const manager = latest(mounted, EnvironmentManagerComponent);
  manager.handleInput(DOWN);
  manager.handleInput(DOWN);
  manager.handleInput(DOWN);
  manager.handleInput(ENTER); // [ Add Environment ]

  await vi.waitFor(() => {
    expect(mounted.some((p) => p instanceof ChoicePickerComponent)).toBe(true);
  });
  const typePicker = latest(mounted, ChoicePickerComponent);
  typePicker.handleInput(ENTER); // first option: SSH host

  await vi.waitFor(() => {
    expect(mounted.filter((p) => p instanceof ChoicePickerComponent).length).toBe(2);
  });
  const hostPicker = latest(mounted, ChoicePickerComponent);
  hostPicker.handleInput(DOWN); // 'staging' — not an existing environment id
  hostPicker.handleInput(ENTER);

  await vi.waitFor(() => {
    expect(mounted.some((p) => p instanceof EnvironmentAddDialogComponent)).toBe(true);
  });
  return latest(mounted, EnvironmentAddDialogComponent);
}

describe('handleEnvironmentCommand', () => {
  it('mounts a loading manager before environment queries settle', async () => {
    const { host, session, mounted } = makeHost({});
    let resolveList!: (value: SessionEnvironmentsInfo) => void;
    session.listEnvironments = vi.fn(
      () => new Promise<SessionEnvironmentsInfo>((resolve) => {
        resolveList = resolve;
      }),
    );

    const opening = handleEnvironmentCommand(host);
    expect(mounted).toHaveLength(1);
    const manager = latest(mounted, EnvironmentManagerComponent);
    expect(manager.render(120).join('\n')).toContain('Loading environments…');

    resolveList(makeEnvironmentsInfo());
    await opening;
    expect(manager.render(120).join('\n')).toContain('dev-box');
  });

  it('ignores a stale environment query after the manager is reopened', async () => {
    const { host, session, mounted } = makeHost({});
    let resolveFirst!: (value: SessionEnvironmentsInfo) => void;
    let resolveSecond!: (value: SessionEnvironmentsInfo) => void;
    session.listEnvironments = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<SessionEnvironmentsInfo>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<SessionEnvironmentsInfo>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const firstOpen = handleEnvironmentCommand(host);
    expect(mounted).toHaveLength(1);
    const secondOpen = handleEnvironmentCommand(host);
    expect(mounted).toHaveLength(2);

    const firstList = makeEnvironmentsInfo({
      environments: [
        { environmentId: 'first-box', type: 'ssh', status: 'ready' },
      ],
    });
    const secondList = makeEnvironmentsInfo({
      environments: [
        { environmentId: 'second-box', type: 'ssh', status: 'ready' },
      ],
    });
    resolveSecond(secondList);
    await secondOpen;
    resolveFirst(firstList);
    await firstOpen;

    const manager = latest(mounted, EnvironmentManagerComponent);
    const plain = manager.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('second-box');
    expect(plain).not.toContain('first-box');
  });

  it('switches to a remote environment through the cwd dialog', async () => {
    const { host, session, mounted } = makeHost({});
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER);

    const dialog = latest(mounted, EnvironmentCwdDialogComponent);
    dialog.handleInput(ENTER); // accept the prefilled defaultCwd
    await vi.waitFor(() => {
      expect(session.switchEnvironment).toHaveBeenCalledWith('dev-box', { cwd: '/home/me/projects' });
    });
    await vi.waitFor(() => {
      expect(host.restoreEditor).toHaveBeenCalled();
    });
    expect(host.refreshEnvironmentSlot).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Environment switched to dev-box.');
  });

  it('keeps handshake or validation failures inline in the cwd dialog', async () => {
    const { host, mounted } = makeHost({
      switchError: new Error('handshake failed: exit code 127\nkimi: command not found'),
    });
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER);
    const dialog = latest(mounted, EnvironmentCwdDialogComponent);
    dialog.handleInput(ENTER);
    await vi.waitFor(() => {
      const plain = dialog.render(100).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('handshake failed: exit code 127');
    });
    expect(host.restoreEditor).not.toHaveBeenCalled();
  });

  it('switches to local directly without a cwd prompt', async () => {
    const { host, session, mounted } = makeHost({ currentEnvironmentId: 'dev-box' });
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    // Selection starts on the current (dev-box) row; local sits above it.
    manager.handleInput('[A');
    manager.handleInput(ENTER);
    await vi.waitFor(() => {
      expect(session.switchEnvironment).toHaveBeenCalledWith('local', undefined);
    });
    expect(mounted.some((p) => p instanceof EnvironmentCwdDialogComponent)).toBe(false);
    await vi.waitFor(() => {
      expect(host.restoreEditor).toHaveBeenCalled();
    });
  });

  it('reconnects the bound disconnected environment on R and refreshes the list', async () => {
    const { host, session, mounted } = makeHost({ currentEnvironmentId: 'sandbox' });
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    manager.handleInput('r');
    await vi.waitFor(() => {
      expect(session.reconnectEnvironment).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(host.refreshEnvironmentSlot).toHaveBeenCalled();
    });
    expect(session.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it('shows a reconnect failure inline in the manager', async () => {
    const { host, mounted } = makeHost({
      currentEnvironmentId: 'sandbox',
      reconnectError: new Error('ssh exited 255'),
    });
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    manager.handleInput('r');
    await vi.waitFor(() => {
      const plain = manager.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('ssh exited 255');
    });
    expect(host.restoreEditor).not.toHaveBeenCalled();
  });

  it('adds an ssh environment from a discovery candidate through the full form flow', async () => {
    const { host, session, mounted } = makeHost({});
    await handleEnvironmentCommand(host);

    const form = await openStagingAddForm(mounted);
    form.handleInput(TAB); // id (empty -> derives from host)
    form.handleInput(TAB); // defaultCwd
    typeText(form, '/home/me/projects');
    form.handleInput(ENTER); // submit

    await vi.waitFor(() => {
      expect(session.declareEnvironment).toHaveBeenCalledWith({
        id: 'staging',
        entry: { type: 'ssh', host: 'staging', defaultCwd: '/home/me/projects' },
      });
    });
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Environment "staging" added to config.toml.');
    });
    // The watch-driven registration lands before the manager reopens, so the
    // new environment is listed immediately.
    await vi.waitFor(() => {
      const reopened = latest(mounted, EnvironmentManagerComponent);
      const plain = reopened.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('staging');
    });
  });

  it('waits for declaration completion before reopening the manager', async () => {
    let finishDeclaration!: () => void;
    const declarationReady = new Promise<void>((resolve) => { finishDeclaration = resolve; });
    const { host, session, mounted } = makeHost({ declarationReady });
    await handleEnvironmentCommand(host);

    const manager = latest(mounted, EnvironmentManagerComponent);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(DOWN);
    manager.handleInput(ENTER); // [ Add Environment ]

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof ChoicePickerComponent)).toBe(true);
    });
    const typePicker = latest(mounted, ChoicePickerComponent);
    typePicker.handleInput(ENTER); // first option: SSH host

    await vi.waitFor(() => {
      expect(mounted.filter((p) => p instanceof ChoicePickerComponent).length).toBe(2);
    });
    const hostPicker = latest(mounted, ChoicePickerComponent);
    hostPicker.handleInput(DOWN); // 'staging' — not an existing environment id
    hostPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(mounted.some((p) => p instanceof EnvironmentAddDialogComponent)).toBe(true);
    });
    const form = latest(mounted, EnvironmentAddDialogComponent);
    form.handleInput(TAB); // id (empty -> derives from host)
    form.handleInput(TAB); // defaultCwd
    typeText(form, '/home/me/projects');
    form.handleInput(ENTER); // submit

    await vi.waitFor(() => { expect(session.declareEnvironment).toHaveBeenCalledTimes(1); });
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(session.listEnvironments).toHaveBeenCalledTimes(1);
    finishDeclaration();

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Environment "staging" added to config.toml.');
    });
    await vi.waitFor(() => {
      const reopened = latest(mounted, EnvironmentManagerComponent);
      const plain = reopened.render(120).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('staging');
    });
  });

  it('keeps engine validation failures inline in the add form', async () => {
    const { host, mounted } = makeHost({
      declareError: new Error('environments section is invalid'),
    });
    await handleEnvironmentCommand(host);

    const form = await openStagingAddForm(mounted);
    form.handleInput(TAB);
    form.handleInput(TAB);
    form.handleInput(ENTER);
    await vi.waitFor(() => {
      const plain = form.render(100).join('\n').replaceAll(/\[[0-9;]*m/g, '');
      expect(plain).toContain('environments section is invalid');
    });
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
