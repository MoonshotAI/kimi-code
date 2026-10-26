import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { compactForModelSwitch, confirmThenPerformModelSwitch, showModelPicker } from '#/tui/commands/config';
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
  vi.unstubAllGlobals();
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
  opts: {
    sessionType: 'old' | 'new';
    hint?: string;
    warning?: string;
    onSelect: (action: ModelSwitchAction) => void;
    onCancel: () => void;
  };
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
    availableProviders: {},
  };
  const session = {
    setModel: vi.fn(async () => ({})),
    setThinking: vi.fn(async () => ({})),
    getStatus: vi.fn(async () => ({ model: 'new-alias', thinkingEffort: 'high' })),
    getResumeState: () => ({ agents: { main: { userTurnCount: 0 } } }),
    onEvent: () => () => {},
    compact: vi.fn(async () => undefined),
  } as unknown as Session;
  const mountEditorReplacement = vi.fn();
  const restoreEditor = vi.fn();
  const host = {
    state: {
      appState,
      transcriptEntries: [{ kind: 'user', bullet: 'hi' }],
      activeDialog: null,
    },
    session,
    harness: { auth: { getCachedAccessToken: vi.fn(async () => 'test-token') } },
    authFlow: { activateModelAfterLogin: vi.fn(async () => true) },
    waitForSessionAssembly: vi.fn(async () => {}),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    mountEditorReplacement,
    restoreEditor,
    showError: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session, appState, mountEditorReplacement, restoreEditor };
}

function mountedDialog(mountEditorReplacement: ReturnType<typeof vi.fn>): MountedDialog {
  return mountEditorReplacement.mock.calls[0]?.[0] as unknown as MountedDialog;
}

async function enableRule(sessionType: 'old' | 'new' | 'all' = 'old'): Promise<void> {
  await refreshModelSwitchConfirmConfig({
    fetchImpl: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'model_switch_confirm',
            config: {
              enable: true,
              rules: [
                {
                  from: 'upstream-old',
                  to: 'upstream-new',
                  session_type: sessionType,
                  hint: { en: 'Switch hint' },
                  warning: { en: 'Switch warning' },
                },
              ],
            },
          }),
        ),
    ) as unknown as typeof fetch,
  });
}

describe('confirmThenPerformModelSwitch', () => {
  afterEach(() => {
    resetModelSwitchConfirmConfigCache();
  });

  it('passes old-session actions and both rule texts to the dialog', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost();
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts).toMatchObject({
      sessionType: 'old',
      hint: 'Switch hint',
      warning: 'Switch warning',
    });
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('switches directly on new-session confirm without compacting', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost();
    host.state.transcriptEntries = [];
    await enableRule('new');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts).toMatchObject({ sessionType: 'new', hint: 'Switch hint', warning: undefined });
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
    });
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('switches directly on old-session continue', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost();
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('continue');
    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
    });
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('does not switch on cancel', async () => {
    const { host, session, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onCancel();

    expect(restoreEditor).toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('ignores duplicate actions and Escape after the first choice', async () => {
    const { host, session, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('continue');
    dialog.opts.onSelect('compact');
    dialog.opts.onCancel();
    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledTimes(1);
    });

    expect(session.compact).not.toHaveBeenCalled();
    expect(restoreEditor).toHaveBeenCalledTimes(1);
  });

  it('switches without a dialog when the rule session type does not match', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost();
    host.state.transcriptEntries = [];
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
    });
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('does not refetch a failed config every time the model picker opens', async () => {
    const { host } = makeSwitchHost();
    host.setAppState({ availableModels: {} });
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchImpl);

    await showModelPicker(host);
    await showModelPicker(host);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(host.showNotice).toHaveBeenCalledTimes(2);
  });
});
