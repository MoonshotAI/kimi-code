// apps/kimi-web/src/composables/__tests__/useKimiWebClient.theme.test.ts
// Theme system: defaults to 'terminal' in jsdom, toggleTheme flips + persists to
// localStorage, and the active theme is mirrored onto <html data-theme>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { KimiWebApi } from '../../api/types';

const fakeConn = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  bindNextPromptId: vi.fn(),
  abort: vi.fn(),
  close: vi.fn(),
};

function makeFakeApi(): KimiWebApi {
  return {
    getHealth: vi.fn().mockResolvedValue({ status: 'ok', uptimeSec: 0 }),
    getMeta: vi.fn().mockResolvedValue({ daemonVersion: 'x', serverId: 's', startedAt: '', capabilities: {} }),
    listSessions: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    listMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    submitPrompt: vi.fn(),
    abortPrompt: vi.fn(),
    respondApproval: vi.fn(),
    respondQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    searchFiles: vi.fn(),
    grepFiles: vi.fn(),
    getGitStatus: vi.fn().mockRejectedValue(new Error('no git')),
    connectEvents: vi.fn().mockReturnValue(fakeConn),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    addWorkspace: vi.fn(),
    browseFs: vi.fn().mockResolvedValue({ path: '', parent: null, entries: [] }),
    getFsHome: vi.fn().mockResolvedValue({ home: '/Users/me', recentRoots: [] }),
    listModels: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    addProvider: vi.fn(),
    deleteProvider: vi.fn(),
    refreshProvider: vi.fn(),
    uploadFile: vi.fn(),
    getAuth: vi.fn().mockResolvedValue({ ready: true, providersCount: 1, defaultModel: 'm', managedProvider: null }),
    startOAuthLogin: vi.fn(),
    pollOAuthLogin: vi.fn(),
    cancelOAuthLogin: vi.fn(),
    logout: vi.fn(),
  } as unknown as KimiWebApi;
}

async function freshClient(api: KimiWebApi) {
  vi.resetModules();
  vi.doMock('../../api', () => ({ getKimiWebApi: () => api }));
  const mod = await import('../useKimiWebClient');
  return mod.useKimiWebClient();
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('../../api');
});

describe('useKimiWebClient — theme', () => {
  it('默认主题为 terminal（jsdom）', async () => {
    const client = await freshClient(makeFakeApi());
    expect(client.theme.value).toBe('terminal');
  });

  it('初始化即把 terminal 写到 <html data-theme>', async () => {
    await freshClient(makeFakeApi());
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('terminal');
  });

  it('toggleTheme 翻转 terminal ↔ modern 并持久化', async () => {
    const client = await freshClient(makeFakeApi());
    client.toggleTheme();
    expect(client.theme.value).toBe('modern');
    expect(localStorage.getItem('kimi-web.theme')).toBe('modern');
    client.toggleTheme();
    expect(client.theme.value).toBe('terminal');
    expect(localStorage.getItem('kimi-web.theme')).toBe('terminal');
  });

  it('切换主题时同步更新 <html data-theme>', async () => {
    const client = await freshClient(makeFakeApi());
    client.setTheme('modern');
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('modern');
    client.setTheme('terminal');
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('terminal');
  });

  it('持久化为 modern 后，重新创建客户端读回 modern', async () => {
    localStorage.setItem('kimi-web.theme', 'modern');
    const client = await freshClient(makeFakeApi());
    expect(client.theme.value).toBe('modern');
  });

  it('setTheme 忽略非法值', async () => {
    const client = await freshClient(makeFakeApi());
    // @ts-expect-error — intentionally passing an invalid theme
    client.setTheme('neon');
    expect(client.theme.value).toBe('terminal');
  });
});
