import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

const clientApiMock: Record<string, unknown> = {};

const CLOUD_CONFIG = {
  enable: true,
  rules: [
    {
      from: 'k3',
      to: 'k3-256k',
      session_type: 'old',
      hint: { en: 'Cache note.', zh: '缓存提示。' },
      warning: { en: 'Highspeed note.', zh: '高速提示。' },
    },
  ],
};

const NEW_SESSION_CLOUD_CONFIG = {
  enable: true,
  rules: [
    {
      from: 'k3',
      to: 'k3-256k',
      session_type: 'new',
      hint: { en: 'Highspeed note.', zh: '高速提示。' },
      warning: { en: 'Old-session warning.', zh: '旧会话警告。' },
    },
  ],
};

const EFFORT_CLOUD_CONFIG = {
  descriptions: {
    enable: true,
    items: {
      low: { en: 'Light reasoning.', zh: '轻量思考。' },
      high: { en: 'Deeper reasoning.', zh: '深入思考。' },
      max: { en: 'Maximum reasoning.', zh: '最大思考强度。' },
    },
  },
  confirm: {
    enable: true,
    rules: [
      {
        from: '*',
        to: '*',
        session_type: 'all',
        hint: { en: 'Effort hint.', zh: '思考强度提示。' },
        warning: { en: 'Effort warning.', zh: '思考强度警告。' },
      },
    ],
  },
};

const CONFIG_MODELS = {
  'kimi-code/k3': { provider: 'kimi-code', model: 'k3' },
  'kimi-code/k3-256k': { provider: 'kimi-code', model: 'k3-256k' },
};

const MODELS = [
  { id: 'kimi-code/k3', provider: 'kimi-code', model: 'kimi-code/k3', displayName: 'K3', maxContextSize: 1048576 },
  { id: 'kimi-code/k3-256k', provider: 'kimi-code', model: 'kimi-code/k3-256k', displayName: 'K3-256k', maxContextSize: 262144 },
];

function makeSession(patch: Record<string, unknown> = {}): AppSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    title: 'demo',
    model: 'kimi-code/k3',
    lastPrompt: 'hello',
    busy: false,
    mainTurnActive: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    ...patch,
  } as unknown as AppSession;
}

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
});

afterEach(() => {
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

type Gate = Awaited<ReturnType<typeof freshGate>>;

function stubEventConnection(): void {
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
}

async function freshGate(options: { config?: unknown; effortConfig?: unknown } = {}) {
  vi.stubGlobal('WebSocket', class {});
  vi.resetModules();
  stubEventConnection();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { modelsStore } = await import('../src/stores/models');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { configStore } = await import('../src/stores/config');
  const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
  const { effortSwitchStore } = await import('../src/stores/effortSwitch');
  const client = useKimiWebClient();
  const msc = modelSwitchConfirmStore();
  const effort = effortSwitchStore();
  msc.resetForTest();
  effort.resetForTest();
  msc.config = ('config' in options ? options.config : CLOUD_CONFIG) as never;
  effort.config = ('effortConfig' in options ? options.effortConfig : undefined) as never;
  modelsStore().setModels(MODELS as never);
  configStore().config = { models: CONFIG_MODELS } as never;
  clientApiMock.updateSession = vi.fn(async () => ({}));
  clientApiMock.setConfig = vi.fn(async (patch: Record<string, unknown>) => ({
    models: CONFIG_MODELS,
    ...patch,
  }));
  return {
    client,
    msc,
    effort,
    sessions: sessionsStore(),
    models: modelsStore(),
    configStore: configStore(),
    updateSession: clientApiMock.updateSession as ReturnType<typeof vi.fn>,
  };
}

function activateSession(gate: Gate, patch: Record<string, unknown> = {}): AppSession {
  const session = makeSession(patch);
  gate.sessions.setSessions([session]);
  gate.sessions.setActiveSessionId(session.id);
  return session;
}

describe('model switch confirm gate', () => {
  it('gates a rule-matched switch behind the dialog and keeps the model on cancel', async () => {
    const gate = await freshGate();
    activateSession(gate);

    const p = gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toMatchObject({
      fromModel: 'K3',
      toModel: 'K3-256k',
      sessionType: 'old',
      hint: 'Cache note.',
      warning: 'Highspeed note.',
    });
    expect(gate.updateSession).not.toHaveBeenCalled();

    gate.msc.settle('cancel');
    await p;
    expect(gate.msc.pending).toBeNull();
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('applies the switch on continue', async () => {
    const gate = await freshGate();
    activateSession(gate);

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('continue');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('gates a rule-matched switch even while the session is busy', async () => {
    const gate = await freshGate();
    activateSession(gate, { busy: true, mainTurnActive: true });

    const p = gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toMatchObject({ fromModel: 'K3', toModel: 'K3-256k' });
    expect(gate.updateSession).not.toHaveBeenCalled();

    gate.msc.settle('cancel');
    await p;
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('applies continue while the session is busy', async () => {
    const gate = await freshGate();
    activateSession(gate, { busy: true, mainTurnActive: true });

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('continue');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('switches directly for the reverse direction', async () => {
    const gate = await freshGate();
    activateSession(gate, { model: 'kimi-code/k3-256k' });

    await gate.client.selectModel('kimi-code/k3');

    expect(gate.msc.pending).toBeNull();
    expect(gate.updateSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ model: 'kimi-code/k3' }));
  });

  it('switches directly when the feature is disabled or the config is missing', async () => {
    const disabled = await freshGate({ config: { enable: false, rules: CLOUD_CONFIG.rules } });
    activateSession(disabled);
    await disabled.client.selectModel('kimi-code/k3-256k');
    expect(disabled.msc.pending).toBeNull();
    expect(disabled.updateSession).toHaveBeenCalled();

    const missing = await freshGate({ config: undefined });
    activateSession(missing);
    await missing.client.selectModel('kimi-code/k3-256k');
    expect(missing.msc.pending).toBeNull();
    expect(missing.updateSession).toHaveBeenCalled();
  });

  it('switches directly when the alias has no upstream id in config.models', async () => {
    const gate = await freshGate();
    activateSession(gate, { model: 'kimi-code/k2' });

    await gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toBeNull();
  });

  it('gates a session without prompts as a new session', async () => {
    const gate = await freshGate({ config: NEW_SESSION_CLOUD_CONFIG });
    activateSession(gate, { lastPrompt: undefined });

    const p = gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toMatchObject({
      fromModel: 'K3',
      toModel: 'K3-256k',
      sessionType: 'new',
      hint: 'Highspeed note.',
      warning: 'Old-session warning.',
    });
    gate.msc.settle('continue');
    await p;
    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('gates a draft-model switch without an active session', async () => {
    const gate = await freshGate({ config: NEW_SESSION_CLOUD_CONFIG });
    gate.models.setDraftModel('kimi-code/k3');

    const p = gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toMatchObject({
      fromModel: 'K3',
      toModel: 'K3-256k',
      sessionType: 'new',
      hint: 'Highspeed note.',
      warning: 'Old-session warning.',
    });
    expect(gate.models.draftModel).toBe('kimi-code/k3');
    gate.msc.settle('continue');
    await p;
    expect(gate.models.draftModel).toBe('kimi-code/k3-256k');
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('loads missing cloud and model config before matching', async () => {
    const gate = await freshGate({ config: undefined });
    gate.configStore.config = null;
    clientApiMock.getConfig = vi.fn(async () => ({ models: CONFIG_MODELS }));
    clientApiMock.getClientConfig = vi.fn(async () => NEW_SESSION_CLOUD_CONFIG);
    gate.models.setDraftModel('kimi-code/k3');

    const p = gate.client.selectModel('kimi-code/k3-256k');

    await vi.waitFor(() => {
      expect(gate.msc.pending).toMatchObject({ sessionType: 'new', hint: 'Highspeed note.' });
    });
    expect(clientApiMock.getConfig).toHaveBeenCalled();
    expect(clientApiMock.getClientConfig).toHaveBeenCalled();
    gate.msc.settle('continue');
    await p;
    expect(gate.models.draftModel).toBe('kimi-code/k3-256k');
  });

  it('discards an older selection that was waiting for config', async () => {
    const gate = await freshGate({ config: undefined });
    activateSession(gate);
    let release!: () => void;
    clientApiMock.getClientConfig = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );

    const first = gate.client.selectModel('kimi-code/k3-256k');
    const second = gate.client.selectModel('kimi-code/k3');
    release();
    await Promise.all([first, second]);

    expect(gate.updateSession).toHaveBeenCalledTimes(1);
    expect(gate.updateSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ model: 'kimi-code/k3' }));
  });

  it('discards a selection when the session changes while config is loading', async () => {
    const gate = await freshGate({ config: undefined });
    activateSession(gate);
    let release!: () => void;
    clientApiMock.getClientConfig = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );

    const selection = gate.client.selectModel('kimi-code/k3-256k');
    activateSession(gate, { id: 'sess-2' });
    release();
    await selection;

    expect(gate.msc.pending).toBeNull();
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('treats a session with messages but no lastPrompt as old', async () => {
    const gate = await freshGate();
    activateSession(gate, { lastPrompt: undefined, messageCount: 3 });

    const p = gate.client.selectModel('kimi-code/k3-256k');

    await vi.waitFor(() => {
      expect(gate.msc.pending).toMatchObject({ sessionType: 'old', hint: 'Cache note.' });
    });
    gate.msc.settle('cancel');
    await p;
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('switches only after the compaction completes', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());
    expect(gate.updateSession).not.toHaveBeenCalled();

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;
    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('flushes queued prompts only after the post-compaction model switch is applied', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));
    clientApiMock.submitPrompt = vi.fn(async () => ({ promptId: 'p1', userMessageId: 'm1', status: 'running' }));
    const { promptStore } = await import('../src/stores/prompt');
    const { connectEventsIfNeeded } = await import('../src/client/useKimiWebClient');
    connectEventsIfNeeded();

    promptStore().queuedBySession = { 'sess-1': [{ text: 'follow up', attachments: undefined }] } as never;
    promptStore().holdCompactFlush('sess-1');
    promptStore().noteCompactionStarted('sess-1');

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(gate.msc.hasCompactionWait('sess-1')).toBe(true));
    expect(clientApiMock.compactSession).not.toHaveBeenCalled();

    promptStore().noteCompactionSettled('sess-1');
    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
    const submitPrompt = clientApiMock.submitPrompt as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(gate.updateSession.mock.invocationCallOrder[0]!).toBeLessThan(
      submitPrompt.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the model unchanged when the compaction is cancelled', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    gate.msc.noteCompactionSettled('sess-1', 'cancelled');
    await p;
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('tolerates choosing compact twice without a spurious failure', async () => {
    const gate = await freshGate();
    activateSession(gate);
    const { promptStore } = await import('../src/stores/prompt');
    const { warningsStore } = await import('../src/stores/warnings');
    let calls = 0;
    clientApiMock.compactSession = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error('already compacting');
      return {};
    });

    const first = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalledTimes(1));

    const second = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await Promise.resolve();
    expect(clientApiMock.compactSession).toHaveBeenCalledTimes(1);

    promptStore().settleCompactStart('sess-1');
    const third = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalledTimes(2));

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await first;
    await second;
    await third;
    const modelSwitchFailures = warningsStore().warnings.filter(
      (w) => typeof w === 'object' && w.details?.some((d) => d.value === 'modelSwitch'),
    );
    expect(modelSwitchFailures).toHaveLength(0);
    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('aborts the switch immediately when the compact request is rejected', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => {
      throw new Error('429 too many requests');
    });

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await p;

    expect(gate.updateSession).not.toHaveBeenCalled();
    expect(gate.msc.hasCompactionWait('sess-1')).toBe(false);

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await Promise.resolve();
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('does not apply the switch when a newer selection superseded it during compaction', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const first = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    await gate.client.selectModel('kimi-code/k3');

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await first;

    expect(gate.updateSession).not.toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('stays silent when a superseded compaction wait settles without completing', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));
    const { warningsStore } = await import('../src/stores/warnings');

    const first = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    await gate.client.selectModel('kimi-code/k3');

    gate.msc.noteCompactionSettled('sess-1', 'cancelled');
    await first;

    expect(
      warningsStore().warnings.filter((w) => JSON.stringify(w).includes('modelSwitch')),
    ).toHaveLength(0);
  });

  it('does not act when the active session changed while the dialog was open', async () => {
    const gate = await freshGate();
    activateSession(gate);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const p = gate.client.selectModel('kimi-code/k3-256k');
    activateSession(gate, { id: 'sess-2' });
    gate.msc.settle('compact');
    await p;

    expect(clientApiMock.compactSession).not.toHaveBeenCalled();
    expect(gate.updateSession).not.toHaveBeenCalled();
  });

  it('applies the switch to the original session when the active session changes during compaction', async () => {
    const gate = await freshGate();
    const first = activateSession(gate);
    gate.sessions.setSessions([first, makeSession({ id: 'sess-2' })]);
    clientApiMock.compactSession = vi.fn(async () => ({}));
    const { warningsStore } = await import('../src/stores/warnings');
    warningsStore().resetWarnings();

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    gate.sessions.setActiveSessionId('sess-2');
    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
    expect(gate.sessions.sessions.find((s) => s.id === 'sess-1')?.model).toBe('kimi-code/k3-256k');
    expect(gate.sessions.sessions.find((s) => s.id === 'sess-2')?.model).toBe('kimi-code/k3');
    expect(gate.updateSession).not.toHaveBeenCalledWith('sess-2', expect.anything());
    expect(clientApiMock.setConfig).not.toHaveBeenCalled();
    expect(
      warningsStore().warnings.filter((w) => JSON.stringify(w).includes('modelSwitch')),
    ).toHaveLength(0);
  });

  it('flushes queued prompts on the original session after switching away during compaction', async () => {
    const gate = await freshGate();
    const first = activateSession(gate);
    gate.sessions.setSessions([first, makeSession({ id: 'sess-2' })]);
    clientApiMock.compactSession = vi.fn(async () => ({}));
    clientApiMock.submitPrompt = vi.fn(async () => ({ promptId: 'p1', userMessageId: 'm1', status: 'running' }));
    const { promptStore } = await import('../src/stores/prompt');
    const { connectEventsIfNeeded } = await import('../src/client/useKimiWebClient');
    connectEventsIfNeeded();

    promptStore().queuedBySession = { 'sess-1': [{ text: 'follow up', attachments: undefined }] } as never;
    promptStore().holdCompactFlush('sess-1');
    promptStore().noteCompactionStarted('sess-1');

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(gate.msc.hasCompactionWait('sess-1')).toBe(true));

    gate.sessions.setActiveSessionId('sess-2');
    promptStore().noteCompactionSettled('sess-1');
    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;

    const submitPrompt = clientApiMock.submitPrompt as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(submitPrompt.mock.calls[0]?.[0]).toBe('sess-1');
    expect(gate.updateSession.mock.invocationCallOrder[0]!).toBeLessThan(
      submitPrompt.mock.invocationCallOrder[0]!,
    );
  });

  it('does not supersede a pending compaction switch when another session selects a model', async () => {
    const gate = await freshGate();
    const first = activateSession(gate);
    gate.sessions.setSessions([first, makeSession({ id: 'sess-2' })]);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    gate.sessions.setActiveSessionId('sess-2');
    const other = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('continue');
    await other;

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-2',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

  it('does not apply the switch when a direct session model selection superseded it during compaction', async () => {
    const gate = await freshGate();
    const first = activateSession(gate);
    gate.sessions.setSessions([first, makeSession({ id: 'sess-2' })]);
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalled());

    gate.sessions.setActiveSessionId('sess-2');
    await gate.client.setSessionModel('sess-1', 'kimi-code/k3');
    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await p;

    expect(gate.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3' }),
    );
    expect(gate.updateSession).not.toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ model: 'kimi-code/k3-256k' }),
    );
  });

});


describe('effort switch confirm gate', () => {
  function useEffortModels(gate: Gate, provider: string): void {
    gate.models.setModels(
      MODELS.map((model) => ({
        ...model,
        provider,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      })) as never,
    );
  }

  function useManagedModels(gate: Gate): void {
    useEffortModels(gate, 'managed:kimi-code');
  }

  async function setCurrentHigh(gate: Gate): Promise<void> {
    useEffortModels(gate, 'kimi-code');
    await gate.client.setThinking('high');
    useManagedModels(gate);
  }

  it('keeps effort unchanged on cancel and applies it on continue for an OAuth model', async () => {
    const cancelled = await freshGate({ effortConfig: EFFORT_CLOUD_CONFIG });
    activateSession(cancelled);
    await setCurrentHigh(cancelled);

    const cancelPending = cancelled.client.setThinking('max');
    expect(cancelled.effort.pending).toMatchObject({
      fromEffort: 'high',
      toEffort: 'max',
      sessionType: 'old',
      hint: 'Effort hint.',
      warning: 'Effort warning.',
    });
    expect(cancelled.client.thinking.value).toBe('high');
    cancelled.effort.settle('cancel');
    await cancelPending;
    expect(cancelled.client.thinking.value).toBe('high');

    const continued = await freshGate({ effortConfig: EFFORT_CLOUD_CONFIG });
    activateSession(continued);
    await setCurrentHigh(continued);
    const continuePending = continued.client.setThinking('max');
    continued.effort.settle('continue');
    await continuePending;
    expect(continued.client.thinking.value).toBe('max');
  });

  it('switches effort directly for a non-OAuth model', async () => {
    const gate = await freshGate({ effortConfig: EFFORT_CLOUD_CONFIG });
    activateSession(gate);
    useEffortModels(gate, 'kimi-code');
    await gate.client.setThinking('high');

    await gate.client.setThinking('max');

    expect(gate.effort.pending).toBeNull();
    expect(gate.client.thinking.value).toBe('max');
  });

  it('shows hint and warning for a new-session effort confirmation', async () => {
    const gate = await freshGate({ effortConfig: EFFORT_CLOUD_CONFIG });
    activateSession(gate, { lastPrompt: undefined });
    await setCurrentHigh(gate);

    const pending = gate.client.setThinking('max');

    expect(gate.effort.pending).toMatchObject({
      sessionType: 'new',
      hint: 'Effort hint.',
      warning: 'Effort warning.',
    });
    gate.effort.settle('cancel');
    await pending;
    expect(gate.client.thinking.value).toBe('high');
  });

  it('uses the default OAuth model when the active session has no model yet', async () => {
    const gate = await freshGate({ effortConfig: EFFORT_CLOUD_CONFIG });
    activateSession(gate, { model: '' });
    await setCurrentHigh(gate);
    gate.models.setDefaultModel('kimi-code/k3');

    const pending = gate.client.setThinking('max');

    expect(gate.effort.pending).toMatchObject({ fromEffort: 'high', toEffort: 'max', sessionType: 'old' });
    gate.effort.settle('cancel');
    await pending;
  });

  it('discards an effort selection when the session changes while config is loading', async () => {
    const gate = await freshGate({ effortConfig: undefined });
    activateSession(gate);
    await setCurrentHigh(gate);
    let release!: () => void;
    clientApiMock.getClientConfig = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(EFFORT_CLOUD_CONFIG);
        }),
    );

    const pending = gate.client.setThinking('max');
    activateSession(gate, { id: 'sess-2' });
    release();
    await pending;

    expect(gate.effort.pending).toBeNull();
    expect(gate.client.thinking.value).toBe('high');
  });
});
