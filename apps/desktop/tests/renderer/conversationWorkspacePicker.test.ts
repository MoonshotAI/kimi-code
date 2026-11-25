// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppDevice } from '@moonshot-ai/app-core/api';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { devicesStore, workspacesStore } from '@moonshot-ai/app-client/stores';

const mockWorkspacesView = ref<WorkspaceView[]>([]);
const mockActiveWorkspaceId = ref<string | null>(null);
const mockVisibleWorkspace = ref<WorkspaceView | null>(null);

vi.mock('@moonshot-ai/app-client/client', () => ({
  sessionObservationOptions: () => ({}),
  turnFileChangesFetcher: () => async () => [],
  useKimiWebClient: () => ({
    onboarded: ref(true),
    dangerousBypassAuth: ref(false),
    turns: ref([]),
    pendingApprovals: ref([]),
    tasks: ref([]),
    todos: ref([]),
    goal: ref(null),
    questions: ref([]),
    turnActive: ref(false),
    isStartingFirstPrompt: ref(false),
    compaction: ref({ state: 'idle' }),
    sessionLoading: ref(false),
    hasMoreMessages: ref(false),
    loadingMoreMessages: ref(false),
    historyWindowState: ref({ startIndex: 0, totalCount: 0 }),
    sessionPlans: ref([]),
    workspacesView: mockWorkspacesView,
    activeWorkspaceId: mockActiveWorkspaceId,
    draftEntry: ref('newChat'),
    draftEntryNonce: ref(0),
    visibleWorkspace: mockVisibleWorkspace,
    status: ref({ cwd: '/work/local', modelId: 'k2', contextUsage: 0, tokenUsage: { input: 0, output: 0 } }),
    activeTurnError: ref(null),
    activeTurnRetry: ref(null),
    activeTurnEnd: ref(null),
    recentSessionsForWorkspace: () => [],
    activeSessionId: ref(undefined),
    sessionById: () => undefined,
    loadOlderMessages: vi.fn(),
    reorderQueuedPrompts: vi.fn(),
    editQueuedPrompt: vi.fn(),
    forkFromTurn: vi.fn(),
  }),
}));

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return {
    ...actual,
    useComposerAutoFocus: vi.fn(),
    useEscInterrupt: () => ({ armed: ref(false), reset: vi.fn() }),
    useWorkspaceTrust: () => ({
      trustDenied: ref(false),
      trustRejected: ref(false),
      trustGateOpen: ref(false),
      busy: ref(false),
      trustWorkspace: vi.fn(),
      rejectTrust: vi.fn(),
      gateSubmitForTrust: () => true,
    }),
  };
});

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: { render: () => null },
}));

vi.mock('@moonshot-ai/app-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-components')>();
  const stub = { render: () => null };
  return {
    ...actual,
    ChatPane: stub,
    Composer: stub,
    ConversationToc: stub,
    KimiCodeWordmark: stub,
    KimiMascotPeek: { setup: (_: unknown, { expose }: { expose: (api: unknown) => void }) => { expose({ playEntrance: vi.fn() }); return () => null; } },
    OpenInMenu: stub,
    WorkspaceRecentSessions: stub,
    WorkspaceTrustDialog: stub,
  };
});

import DesktopConversationPane from '../../src/renderer/components/chat/ConversationPane.vue';

let app: App | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  mockWorkspacesView.value = [];
  mockActiveWorkspaceId.value = null;
  mockVisibleWorkspace.value = null;
  workspacesStore().workspaces = [];
  devicesStore().byId = {};
  devicesStore().loaded = true;
  devicesStore().connecting = {};
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  document.body.innerHTML = '';
});

function sshDevice(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: `${id}.example.test`, status: 'ready', ...extra };
}

function mountPane(component: unknown) {
  const onSelectWorkspace = vi.fn();
  const onAddWorkspace = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(component as never, {
        status: { cwd: '/work/local', modelId: 'k2', contextUsage: 0, tokenUsage: { input: 0, output: 0 } },
        onSelectWorkspace,
        onAddWorkspace,
      }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(ModelDisplayKey, (alias: string | undefined) => alias);
  app.provide(SubagentEffortKey, () => undefined);
  app.mount(host);
  return { el: host, onSelectWorkspace, onAddWorkspace };
}

const localWs: WorkspaceView = { id: 'ws-local', name: 'local-app', root: '/Users/me/local-app', shortPath: '~/local-app', additionalDirs: [], sessionCount: 1 };
const remoteWs: WorkspaceView = { id: 'ws-remote', name: 'trainer', root: '/home/ubuntu/trainer', shortPath: '/home/ubuntu/trainer', deviceId: 'device-gpu', additionalDirs: [], sessionCount: 1 };

function showProjects(): void {
  mockWorkspacesView.value = [localWs, remoteWs];
  mockActiveWorkspaceId.value = 'ws-local';
  mockVisibleWorkspace.value = localWs;
}

describe.each([['desktop', DesktopConversationPane]])('%s ConversationPane project picker with SSH devices', (_platform, Pane) => {
  it('lists projects with their device and leaves SSH devices out of the picker', async () => {
    devicesStore().byId = {
      'device-gpu': sshDevice('device-gpu', { name: 'GPU 开发机', host: 'ubuntu@10.0.0.8', status: 'ready' }),
      'device-idle': sshDevice('device-idle', { name: '空闲机' }),
    };
    showProjects();

    const { el, onSelectWorkspace } = mountPane(Pane);
    await nextTick();

    el.querySelector<HTMLButtonElement>('.ws-chip')!.click();
    await nextTick();

    const rows = [...el.querySelectorAll<HTMLButtonElement>('.ws-list .ws-row')];
    expect(rows.map((row) => row.querySelector('.ws-name')?.textContent)).toEqual(['local-app', 'trainer']);
    expect(rows[1]?.querySelector('.ui-menu-item__description')?.textContent).toBe('GPU 开发机 · /home/ubuntu/trainer');

    const search = el.querySelector<HTMLInputElement>('.ws-search input')!;
    search.value = '10.0.0.8';
    search.dispatchEvent(new Event('input'));
    await nextTick();

    const filtered = [...el.querySelectorAll<HTMLButtonElement>('.ws-list .ws-row')];
    expect(filtered.map((row) => row.querySelector('.ws-name')?.textContent)).toEqual(['trainer']);
    filtered[0]!.click();
    await nextTick();
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith('ws-remote');
  });

  it('disables projects whose device failed to connect', async () => {
    devicesStore().byId = {
      'device-gpu': sshDevice('device-gpu', { name: 'GPU 开发机', status: 'disconnected', connectError: 'Connection refused' }),
    };
    showProjects();

    const { el, onSelectWorkspace } = mountPane(Pane);
    await nextTick();

    el.querySelector<HTMLButtonElement>('.ws-chip')!.click();
    await nextTick();

    const remoteRow = el.querySelectorAll<HTMLButtonElement>('.ws-list .ws-row')[1]!;
    expect(remoteRow.disabled).toBe(true);
    expect(remoteRow.querySelector('.ui-menu-item__description')?.textContent).toContain('GPU 开发机 · /home/ubuntu/trainer');
    remoteRow.click();
    await nextTick();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(el.querySelector('.ws-panel')).not.toBeNull();
  });

  it('offers only add project when no project exists, even with an SSH device configured', async () => {
    devicesStore().byId = {
      'device-dev': sshDevice('device-dev', { name: 'devbox', host: 'devbox', status: 'ready' }),
    };

    const { el, onAddWorkspace } = mountPane(Pane);
    await nextTick();

    const chip = el.querySelector<HTMLButtonElement>('.ws-chip')!;
    chip.click();
    await nextTick();
    expect(onAddWorkspace).toHaveBeenCalledOnce();
    expect(el.querySelector('.ws-panel')).toBeNull();
  });
});
