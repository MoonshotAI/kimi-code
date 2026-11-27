import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { openAgentSettings, useAppDialogs } from '../src/composables/useAppDialogs';
import { useWorkspaceFolderPicker } from '../src/composables/useWorkspaceFolderPicker';
import { useComposerDraft } from '../src/composables/useComposerDraft';
import { restoreSendDraftAtOrigin } from '../src/lib/draftRestore';
import type { PromptEnvelope } from '../src/client';

const onboardedSource = vi.hoisted(() => ({ read: (): boolean => true }));

const client = vi.hoisted(() => ({
  onboarded: {
    get value(): boolean {
      return onboardedSource.read();
    },
  },
  activeWorkspaceId: { value: 'workspace:new' },
  activeSessionId: { value: '' as string },
  activeWorkspaceTrust: { value: undefined as boolean | undefined },
  addWorkspaceByPath: vi.fn(),
  ensureWorkspaceTrust: vi.fn(),
  startSessionAndSendPrompt: vi.fn(),
  refreshAllProviders: vi.fn(),
  selectSession: vi.fn(),
}));

vi.mock('../src/client', () => ({ useKimiWebClient: () => client }));
vi.mock('../src/composables/useIsMobile', () => ({ useIsMobile: () => ref(false) }));

beforeEach(() => {
  vi.resetAllMocks();
  client.activeSessionId.value = '';
  client.activeWorkspaceId.value = 'workspace:new';
  client.activeWorkspaceTrust.value = undefined;
});

afterEach(() => vi.unstubAllGlobals());

it('cancels a pending workspace submission and preserves its text in the original draft', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const scope = ref<string | undefined>(undefined);
  const composer = useComposerDraft({ sessionId: () => scope.value });
  const restore = vi.fn((pending) => composer.loadForEdit(pending.restoreText));
  const dialogs = useAppDialogs({ restorePendingComposer: restore });
  dialogs.pendingWorkspaceSubmit.value = {
    prompt: { text: 'old prompt', attachments: [] } as unknown as PromptEnvelope,
    restoreText: 'old prompt',
  };
  dialogs.openAddWorkspace();
  dialogs.handleCloseAddWorkspace();
  await nextTick();
  expect(dialogs.showAddWorkspace.value).toBe(false);
  expect(dialogs.pendingWorkspaceSubmit.value).toBeNull();
  expect(restore).toHaveBeenCalledOnce();

  scope.value = 'workspace:new';
  await nextTick();
  expect(composer.text.value).toBe('');
  dialogs.handleCloseAddWorkspace();
  expect(restore).toHaveBeenCalledOnce();

  scope.value = undefined;
  await nextTick();
  expect(composer.text.value).toBe('old prompt');
});

it.each([false, undefined])('preserves the pending prompt when the selected folder trust is %s', async (trusted) => {
  client.addWorkspaceByPath.mockResolvedValue(true);
  client.ensureWorkspaceTrust.mockResolvedValue(undefined);
  client.activeWorkspaceTrust.value = trusted;
  client.startSessionAndSendPrompt.mockClear();
  const restore = vi.fn();
  const dialogs = useAppDialogs({ restorePendingComposer: restore });
  const pending = { prompt: { text: 'hello', attachments: [] } as unknown as PromptEnvelope };
  dialogs.pendingWorkspaceSubmit.value = pending;

  expect(await dialogs.addWorkspace('/project')).toBe(true);

  expect(client.ensureWorkspaceTrust).toHaveBeenCalledWith('workspace:new', { background: false });
  expect(client.startSessionAndSendPrompt).not.toHaveBeenCalled();
  expect(restore).toHaveBeenCalledWith(pending);
  expect(dialogs.pendingWorkspaceSubmit.value).toBeNull();
});

it('sends the pending prompt after a project is created and confirmed trusted', async () => {
  client.ensureWorkspaceTrust.mockResolvedValue(undefined);
  client.activeWorkspaceTrust.value = true;
  client.startSessionAndSendPrompt.mockResolvedValue({ sessionId: 'session:new', promptRejected: false });
  const restore = vi.fn();
  const beforePendingPromptSend = vi.fn();
  const onWorkspaceAdded = vi.fn();
  const dialogs = useAppDialogs({ restorePendingComposer: restore, beforePendingPromptSend, onWorkspaceAdded });
  const prompt = { text: 'hello', attachments: [] } as unknown as PromptEnvelope;
  dialogs.pendingWorkspaceSubmit.value = { prompt };

  expect(await dialogs.completeWorkspaceCreation()).toBe(true);

  expect(client.addWorkspaceByPath).not.toHaveBeenCalled();
  expect(onWorkspaceAdded).toHaveBeenCalledOnce();
  expect(beforePendingPromptSend).toHaveBeenCalledOnce();
  expect(client.startSessionAndSendPrompt).toHaveBeenCalledWith('workspace:new', prompt);
  expect(restore).not.toHaveBeenCalled();
});

it.each(['trust', 'send'] as const)('restores to the original draft after switching sessions during %s', async (stage) => {
  client.addWorkspaceByPath.mockResolvedValue(true);
  client.activeWorkspaceTrust.value = true;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  client.ensureWorkspaceTrust.mockImplementation(() => stage === 'trust' ? paused : Promise.resolve());
  client.startSessionAndSendPrompt.mockImplementation(async () => {
    await paused;
    return { sessionId: 'created', promptRejected: true };
  });
  const loadRecoveredDraft = vi.fn();
  const persistDraft = vi.fn();
  const dialogs = useAppDialogs({
    restorePendingComposer: (pending, sessionId) => {
      restoreSendDraftAtOrigin(sessionId, { text: pending.prompt.text }, {
        activeSessionId: () => client.activeSessionId.value || undefined,
        composer: () => ({ isComposerEmpty: () => true, loadRecoveredDraft }),
        persistDraft,
        hasPersistedDraft: () => false,
      });
    },
  });
  dialogs.pendingWorkspaceSubmit.value = { prompt: { text: 'original', attachments: [] } as unknown as PromptEnvelope };
  const adding = dialogs.addWorkspace('/project');
  await vi.waitFor(() => {
    expect(stage === 'trust' ? client.ensureWorkspaceTrust : client.startSessionAndSendPrompt).toHaveBeenCalledOnce();
  });
  client.activeSessionId.value = 'unrelated';
  release();
  await adding;

  expect(loadRecoveredDraft).not.toHaveBeenCalled();
  expect(persistDraft).toHaveBeenCalledWith(stage === 'trust' ? undefined : 'created', 'original', [], undefined);
  if (stage === 'trust') expect(client.startSessionAndSendPrompt).not.toHaveBeenCalled();
});

it('returns every selected workspace folder and clears the picker', async () => {
  const picker = useWorkspaceFolderPicker();
  const pending = picker.pickWorkspaceFolders();

  picker.completeWorkspaceFolderPicker(['/project/a', '/project/b']);

  await expect(pending).resolves.toEqual(['/project/a', '/project/b']);
  expect(picker.folderPickerResolve.value).toBeNull();
});

it('returns an empty path list when the workspace folder picker is cancelled', async () => {
  const picker = useWorkspaceFolderPicker();
  const pending = picker.pickWorkspaceFolders();

  picker.cancelWorkspaceFolderPicker();

  await expect(pending).resolves.toEqual([]);
  expect(picker.folderPickerResolve.value).toBeNull();
});

it('refreshes provider catalogs before opening the quick model menu without navigating to a background session', async () => {
  client.activeSessionId.value = 'active-session';
  const openQuickModelMenu = vi.fn();
  const dialogs = useAppDialogs({ restorePendingComposer: vi.fn(), openQuickModelMenu });

  await dialogs.openModelPicker('background-session');

  expect(client.refreshAllProviders).toHaveBeenCalledOnce();
  expect(client.selectSession).not.toHaveBeenCalled();
  expect(client.activeSessionId.value).toBe('active-session');
  expect(openQuickModelMenu).toHaveBeenCalledWith('background-session');
});

it('sets and clears settingsHighlightKey across desktop and mobile agent settings deep links', async () => {
  const dialogs = useAppDialogs();
  dialogs.showSettings.value = false;
  dialogs.showMobileSettings.value = false;
  await nextTick();

  openAgentSettings(false);
  expect(dialogs.showSettings.value).toBe(true);
  expect(dialogs.settingsInitialTab.value).toBe('agent');
  expect(dialogs.settingsHighlightKey.value).toBe('running-send-mode');

  dialogs.openProviderSettings();
  expect(dialogs.settingsHighlightKey.value).toBeUndefined();

  openAgentSettings(true);
  await nextTick();
  expect(dialogs.showSettings.value).toBe(false);
  expect(dialogs.showMobileSettings.value).toBe(true);
  expect(dialogs.settingsHighlightKey.value).toBe('running-send-mode');

  dialogs.showMobileSettings.value = false;
  await nextTick();
  expect(dialogs.settingsHighlightKey.value).toBeUndefined();
});

async function dialogsOnFreshServer(serverValues: Record<string, unknown>) {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const lib = await import('@moonshot-ai/app-core/lib');
  lib.uiPreferences.bind('http://127.0.0.1:58627');
  onboardedSource.read = () => lib.loadOnboarded();
  const deps = await import('../src/client/deps');
  deps.setKimiClientDeps({
    api: () => ({ getUiPreferences: async () => ({ revision: 3, values: serverValues }) }) as never,
    t: (key) => key,
  });
  const { useAppDialogs: freshAppDialogs } = await import('../src/composables/useAppDialogs');
  const { uiPreferencesStore } = await import('../src/stores/uiPreferences');
  return { dialogs: freshAppDialogs(), sync: () => uiPreferencesStore().refresh(), done: () => deps.resetKimiClientDeps() };
}

it('does not show onboarding to a new browser when this server says it was completed elsewhere', async () => {
  const { dialogs, sync, done } = await dialogsOnFreshServer({ 'onboarding.completed': true });
  try {
    expect(dialogs.showOnboarding.value).toBe(false);
    await sync();
    await nextTick();
    expect(dialogs.showOnboarding.value).toBe(false);
  } finally {
    done();
    onboardedSource.read = () => true;
  }
});

it('shows onboarding once the server confirms it was never completed', async () => {
  const { dialogs, sync, done } = await dialogsOnFreshServer({});
  try {
    expect(dialogs.showOnboarding.value).toBe(false);
    await sync();
    await nextTick();
    expect(dialogs.showOnboarding.value).toBe(true);
  } finally {
    done();
    onboardedSource.read = () => true;
  }
});
