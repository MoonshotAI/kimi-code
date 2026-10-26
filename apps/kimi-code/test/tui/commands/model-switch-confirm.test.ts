import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { compactForModelSwitch, confirmThenPerformModelSwitch } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
  type ModelSwitchAction,
} from '#/utils/model-switch-confirm-config';

type TestEvent = { type: string; code?: string };

function fakeSession() {
  const listeners = new Set<(event: TestEvent) => void>();
  const compact = vi.fn(async () => undefined);
  const session = {
    onEvent: (listener: (event: TestEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    compact,
  } as unknown as Session;
  return {
    session,
    compact,
    listenerCount: () => listeners.size,
    emit: (event: TestEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function fakeHost(session: Session) {
  return {
    session,
    showError: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('compactForModelSwitch', () => {
  it('compacts and proceeds once the completed event lands', async () => {
    const { session, compact, emit, listenerCount } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed' });

    await expect(pending).resolves.toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
  });

  it('aborts with a notice when the compaction is cancelled', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.cancelled' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Compaction cancelled — model unchanged.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('aborts when the compaction fails', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'error', code: 'compaction.failed' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — model unchanged.');
  });

  it('aborts when the compact request itself rejects', async () => {
    const { session, compact } = fakeSession();
    compact.mockRejectedValue(new Error('engine busy'));
    const host = fakeHost(session);

    await expect(compactForModelSwitch(host, session)).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith('Failed to compact: engine busy. Model unchanged.');
  });

  it('aborts when the session changed while waiting', async () => {
    const { session, emit } = fakeSession();
    const { session: otherSession } = fakeSession();
    const host = fakeHost(otherSession);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — session changed.');
  });

  it('aborts with an error when the compaction never settles', async () => {
    vi.useFakeTimers();
    const { session } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(pending).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith('Timed out waiting for compaction — model unchanged.');
  });
});

type MountedDialog = {
  opts: { onSelect: (action: ModelSwitchAction) => void; onCancel: () => void };
};

function makeSwitchHost() {
  const appState = {
    model: 'old-alias',
    thinkingEffort: 'off',
    streamingPhase: 'idle',
    sessionId: 'ses-old',
    availableModels: {
      'old-alias': { model: 'upstream-old', displayName: 'Old' },
      'new-alias': { model: 'upstream-new', displayName: 'New' },
    },
  };
  const session = {
    setModel: vi.fn(async () => ({})),
    setThinking: vi.fn(async () => ({})),
    getStatus: vi.fn(async () => ({ model: 'new-alias', thinkingEffort: 'high' })),
    onEvent: () => () => {},
    compact: vi.fn(async () => undefined),
  } as unknown as Session;
  const mountEditorReplacement = vi.fn();
  const restoreEditor = vi.fn();
  const createNewSession = vi.fn(async () => {});
  const activateModelAfterLogin = vi.fn(async () => true);
  const host = {
    state: {
      appState,
      transcriptEntries: [{ kind: 'user', bullet: 'hi' }],
      activeDialog: null,
    },
    session,
    authFlow: { activateModelAfterLogin },
    createNewSession,
    waitForLazyCreation: vi.fn(async () => {}),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    mountEditorReplacement,
    restoreEditor,
    showError: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session, appState, mountEditorReplacement, restoreEditor, createNewSession, activateModelAfterLogin };
}

function mountedDialog(mountEditorReplacement: ReturnType<typeof vi.fn>): MountedDialog {
  return mountEditorReplacement.mock.calls[0]?.[0] as unknown as MountedDialog;
}

async function enableRule(): Promise<void> {
  await refreshModelSwitchConfirmConfig({
    fetchImpl: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'model_switch_confirm',
            config: { enable: true, rules: [{ from: 'upstream-old', to: 'upstream-new' }] },
          }),
        ),
    ) as unknown as typeof fetch,
  });
}

describe('confirmThenPerformModelSwitch new-session action', () => {
  afterEach(() => {
    resetModelSwitchConfirmConfigCache();
  });

  it('does not switch when the new session fails to be created', async () => {
    const { host, session, mountEditorReplacement, activateModelAfterLogin } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('new');
    await vi.waitFor(() => expect(host.restoreEditor).toHaveBeenCalled());

    expect(session.setModel).not.toHaveBeenCalled();
    expect(activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('switches only after the new session is ready, keeping the dialog locked meanwhile', async () => {
    const { host, session, appState, mountEditorReplacement, restoreEditor, createNewSession } =
      makeSwitchHost();
    await enableRule();
    let releaseCreation!: () => void;
    createNewSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCreation = resolve;
        }),
    );
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    dialog.opts.onSelect('new');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(restoreEditor).not.toHaveBeenCalled();

    releaseCreation();
    await vi.waitFor(() => expect(restoreEditor).toHaveBeenCalled());
    expect(session.setModel).not.toHaveBeenCalled();
    expect(appState.sessionId).toBe('ses-old');
  });

  it('switches the model once the new session exists', async () => {
    const { host, session, appState, mountEditorReplacement, createNewSession } = makeSwitchHost();
    await enableRule();
    createNewSession.mockImplementation(async () => {
      appState.sessionId = 'ses-new';
    });
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('new');
    await vi.waitFor(() => expect(host.restoreEditor).toHaveBeenCalled());

    expect(session.setModel).toHaveBeenCalledWith('new-alias');
  });

  it('dismisses on Escape before any action is chosen', async () => {
    const { host, session, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onCancel();

    expect(restoreEditor).toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('ignores Escape once an action has been chosen', async () => {
    const { host, mountEditorReplacement, restoreEditor, createNewSession } = makeSwitchHost();
    await enableRule();
    let releaseCreation!: () => void;
    createNewSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCreation = resolve;
        }),
    );
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    dialog.opts.onCancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoreEditor).not.toHaveBeenCalled();

    releaseCreation();
    await vi.waitFor(() => expect(restoreEditor).toHaveBeenCalled());
  });

  it('does not dismiss a panel that displaced the dialog when creation settles', async () => {
    const { host, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    (host.state as unknown as { activeDialog: string | null }).activeDialog = null;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restoreEditor).not.toHaveBeenCalled();
  });
});
