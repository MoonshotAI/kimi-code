import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { compactForModelSwitch, confirmThenPerformModelSwitch, handleEffortCommand, showModelPicker } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
  type ModelSwitchAction,
} from '#/utils/model-switch-confirm-config';
import {
  refreshEffortSwitchConfig,
  resetEffortSwitchConfigCache,
} from '#/utils/effort-switch-config';

type TestEvent = { type: string; code?: string; agentId?: string };

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
    emit({ type: 'compaction.completed', agentId: 'main' });

    await expect(pending).resolves.toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
  });

  it('ignores a child agent compaction until the main agent finishes', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);
    let settled = false;
    const pending = compactForModelSwitch(host, session).then((value) => {
      settled = true;
      return value;
    });

    emit({ type: 'compaction.completed', agentId: 'child-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    emit({ type: 'compaction.completed', agentId: 'main' });
    await expect(pending).resolves.toBe(true);
  });

  it('aborts with a notice when the compaction is cancelled', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.cancelled', agentId: 'main' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Compaction cancelled — model unchanged.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('aborts when the compaction fails', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'error', code: 'compaction.failed', agentId: 'main' });

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
    emit({ type: 'compaction.completed', agentId: 'main' });

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
    kind?: 'model' | 'effort';
    fromModel: string;
    toModel: string;
    hint?: string;
    warning?: string;
    onSelect: (action: ModelSwitchAction) => void;
    onCancel: () => void;
  };
};

function makeSwitchHost(provider = 'custom') {
  const listeners = new Set<(event: TestEvent) => void>();
  const appState = {
    model: 'old-alias',
    thinkingEffort: 'off',
    streamingPhase: 'idle',
    isCompacting: false,
    sessionId: 'ses-old',
    availableModels: {
      'old-alias': {
        provider,
        model: 'upstream-old',
        displayName: 'Old',
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      },
      'new-alias': {
        provider,
        model: 'upstream-new',
        displayName: 'New',
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      },
    },
    availableProviders: {},
  };
  let currentModel = 'old-alias';
  let currentEffort: ThinkingEffort = 'off';
  const session = {
    setModel: vi.fn(async (alias: string) => {
      currentModel = alias;
    }),
    setThinking: vi.fn(async (effort: ThinkingEffort) => {
      currentEffort = effort;
    }),
    getStatus: vi.fn(async () => ({ model: currentModel, thinkingEffort: currentEffort })),
    getResumeState: () => ({ agents: { main: { userTurnCount: 0 } } }),
    onEvent: (listener: (event: TestEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    compact: vi.fn(async () => undefined),
  } as unknown as Session;
  const mountEditorReplacement = vi.fn();
  const restoreEditor = vi.fn();
  const turnContext: { turnId: string | undefined; step: number } = { turnId: undefined, step: 0 };
  const host = {
    state: {
      appState,
      transcriptEntries: [{ kind: 'user', bullet: 'hi' }],
      activeDialog: null,
      queuedMessageDispatchPending: false,
    },
    session,
    streamingUI: {
      hasActiveTurn: vi.fn(() => turnContext.turnId !== undefined),
      getTurnContext: vi.fn(() => turnContext),
    },
    resetLivePane: vi.fn(),
    drainQueueIfIdle: vi.fn(),
    enqueueModelSwitch: vi.fn(),
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
  const emit = (event: TestEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return { host, session, appState, mountEditorReplacement, restoreEditor, emit, turnContext };
}

function mountedDialog(mountEditorReplacement: ReturnType<typeof vi.fn>): MountedDialog {
  return mountEditorReplacement.mock.calls[0]?.[0] as unknown as MountedDialog;
}

async function enableEffortConfig(sessionType: 'old' | 'new' | 'all' = 'all'): Promise<void> {
  await refreshEffortSwitchConfig({
    fetchImpl: vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'effort_switch_confirm',
          config: {
            descriptions: {
              enable: true,
              items: {
                low: { en: 'Light reasoning.' },
                high: { en: 'Deeper reasoning.' },
                max: { en: 'Maximum reasoning.' },
              },
            },
            confirm: {
              enable: true,
              rules: [
                {
                  from: '*',
                  to: '*',
                  session_type: sessionType,
                  hint: { en: 'Effort hint' },
                  warning: { en: 'Effort warning' },
                },
              ],
            },
          },
        }),
      ),
    ) as unknown as typeof fetch,
  });
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
    resetEffortSwitchConfigCache();
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
    expect(dialog.opts).toMatchObject({ sessionType: 'new', hint: 'Switch hint', warning: 'Switch warning' });
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

  it('keeps streamingPhase idle during an old-session continue switch', async () => {
    const { host, session, appState, mountEditorReplacement } = makeSwitchHost();
    let finishSwitch!: () => void;
    const switchPending = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    vi.mocked(session.setModel).mockImplementationOnce(() => switchPending);
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('continue');
    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
    });

    expect(appState.streamingPhase).toBe('idle');
    expect(host.resetLivePane).not.toHaveBeenCalled();
    finishSwitch();
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledTimes(1);
    });
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

  it('gates a pure effort switch for an OAuth subscription model', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    await enableEffortConfig();

    confirmThenPerformModelSwitch(host, 'old-alias', 'high', 'session');

    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts).toMatchObject({
      kind: 'effort',
      fromModel: 'off',
      toModel: 'high',
      sessionType: 'old',
      hint: 'Effort hint',
      warning: 'Effort warning',
    });
    expect(session.setThinking).not.toHaveBeenCalled();
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => expect(session.setThinking).toHaveBeenCalledWith('high'));
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('shows hint and warning for a new-session effort switch and keeps effort on cancel', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    host.state.transcriptEntries = [];
    await enableEffortConfig('new');

    confirmThenPerformModelSwitch(host, 'old-alias', 'high', 'session');

    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts).toMatchObject({
      kind: 'effort',
      sessionType: 'new',
      hint: 'Effort hint',
      warning: 'Effort warning',
    });
    dialog.opts.onCancel();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('switches effort directly for a non-OAuth model', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('custom');
    await enableEffortConfig();

    await handleEffortCommand(host, 'high');

    expect(session.setThinking).toHaveBeenCalledWith('high');
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('ignores effort rules when the model changes at the same time', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    await enableEffortConfig();

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('gates a direct /effort argument before applying the new effort', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    await enableEffortConfig();

    await handleEffortCommand(host, 'high');

    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts).toMatchObject({ kind: 'effort', fromModel: 'off', toModel: 'high' });
    expect(session.setThinking).not.toHaveBeenCalled();
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => expect(session.setThinking).toHaveBeenCalledWith('high'));
  });

  it('shows cloud descriptions and gates Alt+S while preserving session-only scope', async () => {
    const { host, session, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    await enableEffortConfig();

    await handleEffortCommand(host, '');

    const selector = mountEditorReplacement.mock.calls[0]?.[0] as unknown as {
      opts: {
        descriptions: Record<string, string>;
        onSessionOnlySelect: (effort: string) => void;
      };
    };
    expect(selector.opts.descriptions).toEqual({
      low: 'Light reasoning.',
      high: 'Deeper reasoning.',
      max: 'Maximum reasoning.',
    });
    selector.opts.onSessionOnlySelect('high');
    await vi.waitFor(() => expect(mountEditorReplacement).toHaveBeenCalledTimes(2));
    const dialog = mountEditorReplacement.mock.calls[1]?.[0] as unknown as MountedDialog;
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => expect(session.setThinking).toHaveBeenCalledWith('high'));
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('shows the model confirmation while busy and queues Compact and continue', async () => {
    const { host, session, appState, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    appState.streamingPhase = 'waiting';
    await enableRule('old');

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts.sessionType).toBe('old');
    expect(session.setModel).not.toHaveBeenCalled();

    dialog.opts.onSelect('compact');

    await vi.waitFor(() => {
      expect(host.enqueueModelSwitch).toHaveBeenCalledWith('new-alias', 'high', 'session');
    });
    expect(session.compact).not.toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('shows the effort confirmation while compacting and switches immediately on continue', async () => {
    const { host, session, appState, mountEditorReplacement } = makeSwitchHost('managed:kimi-code');
    appState.isCompacting = true;
    await enableEffortConfig();

    confirmThenPerformModelSwitch(host, 'old-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);
    expect(dialog.opts.kind).toBe('effort');
    expect(session.setThinking).not.toHaveBeenCalled();

    dialog.opts.onSelect('continue');

    await vi.waitFor(() => {
      expect(session.setThinking).toHaveBeenCalledWith('high');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Thinking set to high for this session only. Takes effect from the next turn.',
        'success',
      );
    });
  });

  it('switches directly once the turn has sent a request when no cloud rule matches', async () => {
    const { host, session, appState, mountEditorReplacement, turnContext } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    turnContext.turnId = '4';
    turnContext.step = 1;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only. Takes effect from the next turn.',
        'success',
      );
    });
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('does not promise a next-turn switch after submit and before the first request', async () => {
    const { host, session, appState, turnContext } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    turnContext.step = 3;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only.',
        'success',
      );
    });
  });

  it('does not promise a next-turn switch after the turn starts and before its first step', async () => {
    const { host, session, appState, turnContext } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    turnContext.turnId = '7';
    turnContext.step = 0;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only.',
        'success',
      );
    });
  });

  it('promises a next-turn switch while a shell command is running', async () => {
    const { host, session, appState } = makeSwitchHost();
    appState.streamingPhase = 'shell';

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only. Takes effect from the next turn.',
        'success',
      );
    });
  });

  it('keeps an idle switch notice unchanged when replay left a started step', async () => {
    const { host, session, turnContext } = makeSwitchHost();
    turnContext.turnId = 'replay:2';
    turnContext.step = 2;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only.',
        'success',
      );
    });
  });

  it('keeps the already-using notice unchanged while busy', async () => {
    const { host, appState } = makeSwitchHost();
    appState.streamingPhase = 'waiting';

    confirmThenPerformModelSwitch(host, 'old-alias', 'off', 'session');

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith(
        'Already using Old with thinking off.',
        'success',
      );
    });
  });

  it('compacts then switches without a next-turn notice when idle', async () => {
    const { host, session, mountEditorReplacement, emit } = makeSwitchHost('managed:kimi-code');
    await enableRule('old');
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('compact');
    await vi.waitFor(() => {
      expect(session.compact).toHaveBeenCalledWith({});
    });
    expect(session.setModel).not.toHaveBeenCalled();

    emit({ type: 'compaction.completed', agentId: 'main' });

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('new-alias');
      expect(host.showStatus).toHaveBeenCalledWith(
        'Switched to New with thinking high for this session only.',
        'success',
      );
      expect(host.drainQueueIfIdle).toHaveBeenCalled();
    });
    expect(host.state.queuedMessageDispatchPending).toBe(false);
  });

  it('does not refetch failed configs every time the model picker opens', async () => {
    const { host } = makeSwitchHost();
    host.setAppState({ availableModels: {} });
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchImpl);

    await showModelPicker(host);
    await showModelPicker(host);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(host.showNotice).toHaveBeenCalledTimes(2);
  });
});
