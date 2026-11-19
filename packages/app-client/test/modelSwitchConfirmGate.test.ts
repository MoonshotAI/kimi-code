import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

const clientApiMock: Record<string, unknown> = {};

const CLOUD_CONFIG = {
  enable: true,
  rules: [{ from: 'k3', to: 'k3-256k', hint: { en: 'Cache note.', zh: '缓存提示。' } }],
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

function makeLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
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

async function freshGate(options: { config?: unknown } = {}) {
  vi.stubGlobal('WebSocket', class {});
  vi.resetModules();
  stubEventConnection();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { modelsStore } = await import('../src/stores/models');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { configStore } = await import('../src/stores/config');
  const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
  const client = useKimiWebClient();
  const msc = modelSwitchConfirmStore();
  msc.resetForTest();
  msc.config = ('config' in options ? options.config : CLOUD_CONFIG) as never;
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
    sessions: sessionsStore(),
    models: modelsStore(),
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
      hint: 'Cache note.',
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

  it('switches directly when the session has never seen a prompt', async () => {
    const gate = await freshGate();
    activateSession(gate, { lastPrompt: undefined });

    await gate.client.selectModel('kimi-code/k3-256k');

    expect(gate.msc.pending).toBeNull();
    expect(gate.updateSession).toHaveBeenCalled();
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

  it('starts a new session, carries the draft over, and switches the draft model', async () => {
    vi.stubGlobal('localStorage', makeLocalStorage());
    const gate = await freshGate();
    activateSession(gate);
    const { draftStorageKey } = await import('@moonshot-ai/app-core/lib');
    localStorage.setItem(draftStorageKey('sess-1'), 'draft keep me');

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('new');
    await p;

    expect(gate.sessions.activeSessionId).toBeUndefined();
    expect(localStorage.getItem(draftStorageKey(undefined))).toBe('draft keep me');
    expect(gate.models.draftModel).toBe('kimi-code/k3-256k');
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
    clientApiMock.compactSession = vi.fn(async () => ({}));

    const first = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalledTimes(1));

    const second = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('compact');
    await vi.waitFor(() => expect(clientApiMock.compactSession).toHaveBeenCalledTimes(2));

    gate.msc.noteCompactionSettled('sess-1', 'completed');
    await first;
    await second;
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

  it('replaces the new-session draft wholesale and clears stale target keys', async () => {
    vi.stubGlobal('localStorage', makeLocalStorage());
    const gate = await freshGate();
    activateSession(gate);
    const { draftStorageKey, draftSnapshotStorageKey, draftAttachmentsStorageKey } = await import('@moonshot-ai/app-core/lib');
    localStorage.setItem(draftStorageKey('sess-1'), 'fresh text');
    localStorage.setItem(draftSnapshotStorageKey(undefined), '{"stale":true}');
    localStorage.setItem(draftAttachmentsStorageKey(undefined), '[{"stale":true}]');

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('new');
    await p;

    expect(localStorage.getItem(draftStorageKey(undefined))).toBe('fresh text');
    expect(localStorage.getItem(draftSnapshotStorageKey(undefined))).toBeNull();
    expect(localStorage.getItem(draftAttachmentsStorageKey(undefined))).toBeNull();
  });

  it('drops the stashed new-session editor state so the migrated draft is the restore source', async () => {
    vi.stubGlobal('localStorage', makeLocalStorage());
    const gate = await freshGate();
    activateSession(gate);
    const { draftStorageKey, composerSessionScope } = await import('@moonshot-ai/app-core/lib');
    const { stashEditorState, takeEditorState } = await import('../../app-composer/src/runtime/editorStateCache');
    localStorage.setItem(draftStorageKey('sess-1'), 'migrated text');
    const scope = composerSessionScope(undefined);
    stashEditorState(scope, {} as Parameters<typeof stashEditorState>[1]);

    const p = gate.client.selectModel('kimi-code/k3-256k');
    gate.msc.settle('new');
    await p;

    expect(takeEditorState(scope)).toBeUndefined();
    expect(localStorage.getItem(draftStorageKey(undefined))).toBe('migrated text');
  });

});
