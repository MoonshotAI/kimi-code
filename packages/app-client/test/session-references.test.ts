import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import { useSessionMentions } from '@moonshot-ai/app-core';
import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';
import { serializeMention } from '@moonshot-ai/app-composer/model';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useKimiWebClient } from '../src/client/useKimiWebClient';
import { buildPromptContent } from '../src/lib/browserReferenceSubmission';
import {
  hasUnresolvedSessionReferences,
  resolveSessionReferences,
  sessionLogPath,
  sessionMentionCandidates,
  withSessionReferences,
} from '../src/lib/sessionReferences';
import { configStore } from '../src/stores/config';
import { sessionsStore } from '../src/stores/sessions';

const APP_WORKSPACE = 'wd_app_0123456789ab';
const API_WORKSPACE = 'wd_api_0123456789ab';
const HOME = '/home/me/.kimi-code';

function session(id: string, overrides: Partial<AppSession> = {}): AppSession {
  return {
    id,
    title: `Title ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/work/app',
    model: 'model-1',
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
    workspaceId: APP_WORKSPACE,
    ...overrides,
  };
}

function mention(sessionId: string, title: string): string {
  return serializeMention({ kind: 'session', name: title, path: sessionId });
}

function logPath(workspaceId: string, sessionId: string): string {
  return `${HOME}/sessions/${workspaceId}/${sessionId}/agents/main/wire.jsonl`;
}

describe('sessionMentionCandidates', () => {
  it('offers local, unarchived sessions other than the active one, current workspace first and newest first', () => {
    const names: Record<string, string> = { [APP_WORKSPACE]: 'app', [API_WORKSPACE]: 'api' };
    const candidates = sessionMentionCandidates({
      sessions: [
        session('older-here', { updatedAt: '2026-01-02T00:00:00.000Z' }),
        session('newer-elsewhere', { workspaceId: API_WORKSPACE, updatedAt: '2026-01-05T00:00:00.000Z' }),
        session('newer-here', { updatedAt: '2026-01-04T00:00:00.000Z' }),
        session('active', { updatedAt: '2026-01-06T00:00:00.000Z' }),
        session('archived', { archived: true }),
        session('remote', { hostId: 'devbox' }),
        session('unscoped', { workspaceId: undefined }),
      ],
      activeSessionId: 'active',
      activeWorkspaceId: APP_WORKSPACE,
      workspaceName: (id) => names[id],
      formatTime: (iso) => iso.slice(5, 10),
    });
    expect(candidates).toEqual([
      { id: 'newer-here', workspaceId: APP_WORKSPACE, title: 'Title newer-here', workspaceName: 'app', time: '01-04' },
      { id: 'older-here', workspaceId: APP_WORKSPACE, title: 'Title older-here', workspaceName: 'app', time: '01-02' },
      { id: 'newer-elsewhere', workspaceId: API_WORKSPACE, title: 'Title newer-elsewhere', workspaceName: 'api', time: '01-05' },
    ]);
  });

  it('titles untitled sessions by their last prompt, then by their id', () => {
    const candidates = sessionMentionCandidates({
      sessions: [
        session('prompted', { title: '', lastPrompt: 'Fix\n  the   login', updatedAt: '2026-01-02T00:00:00.000Z' }),
        session('bare', { title: '  ' }),
      ],
      workspaceName: () => undefined,
      formatTime: () => '',
    });
    expect(candidates.map((candidate) => candidate.title)).toEqual(['Fix the login', 'bare']);
  });
});

describe('session mentions lab switch', () => {
  afterEach(() => {
    useSessionMentions().setSessionMentions(false);
    sessionsStore().setSessions([]);
    resetKimiClientDeps();
  });

  it('offers no sessions and skips the server search until the switch is on', async () => {
    const listSessions = vi.fn(async () => ({ items: [session('found')], hasMore: false, nextPageToken: null, total: 1 }));
    setKimiClientDeps({ api: () => ({ listSessions }) as unknown as KimiWebApi, t: (key) => key });
    sessionsStore().setSessions([session('loaded')]);
    const client = useKimiWebClient();
    const signal = new AbortController().signal;

    expect(client.sessionMentionCandidates.value).toEqual([]);
    expect(await client.searchSessionMentions('found', { signal })).toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();

    useSessionMentions().setSessionMentions(true);

    expect(localStorage.getItem('kimi-web.session-mentions')).toBe('1');
    expect(client.sessionMentionCandidates.value.map((candidate) => candidate.id)).toEqual(['loaded']);
    expect((await client.searchSessionMentions('found', { signal })).map((candidate) => candidate.id)).toEqual(['found']);
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ query: 'found', localOnly: true }), { signal });
  });
});

describe('sessionLogPath', () => {
  it('points at the main agent event log under the Kimi Code home', () => {
    expect(sessionLogPath('/home/me/.kimi-code/', APP_WORKSPACE, 'session_1')).toBe(logPath(APP_WORKSPACE, 'session_1'));
    expect(sessionLogPath('C:\\Users\\me\\.kimi-code', APP_WORKSPACE, 'session_1')).toBe(`C:/Users/me/.kimi-code/sessions/${APP_WORKSPACE}/session_1/agents/main/wire.jsonl`);
  });
});

describe('withSessionReferences', () => {
  const getSession = vi.fn<(sessionId: string, options?: unknown) => Promise<AppSession>>();

  beforeEach(() => {
    configStore().homeDir = HOME;
    sessionsStore().setSessions([
      session('session_1'),
      session('session_9', { workspaceId: API_WORKSPACE }),
      session('remote_loaded', { hostId: 'devbox' }),
    ]);
    setKimiClientDeps({ api: () => ({ getSession }) as unknown as KimiWebApi, t: (key) => key });
  });

  afterEach(() => {
    configStore().homeDir = '';
    sessionsStore().setSessions([]);
    getSession.mockReset();
    resetKimiClientDeps();
  });

  it('leaves prompts without session mentions untouched', () => {
    const text = 'see [a.ts](src/a.ts) and [deploy](kimi-code://skill/deploy)';
    expect(hasUnresolvedSessionReferences(text)).toBe(false);
    expect(withSessionReferences(text)).toBe(text);
  });

  it('appends one escaped log reference per mentioned session under the server data directory', () => {
    const link = mention('session_1', 'Fix "login" <redirect>');
    const other = mention('session_9', 'Elsewhere');
    const text = `compare ${link} with ${link} and ${other}`;

    expect(hasUnresolvedSessionReferences(text)).toBe(false);
    expect(withSessionReferences(text)).toBe([
      text,
      '',
      '<referenced_sessions>',
      `<session id="session_1" title="Fix &quot;login&quot; &lt;redirect&gt;" log="${logPath(APP_WORKSPACE, 'session_1')}" />`,
      `<session id="session_9" title="Elsewhere" log="${logPath(API_WORKSPACE, 'session_9')}" />`,
      '</referenced_sessions>',
    ].join('\n'));
  });

  it('leaves the prompt untouched until the server has reported its data directory', () => {
    configStore().homeDir = '';
    const text = `continue ${mention('session_1', 'Fix login')}`;
    expect(withSessionReferences(text)).toBe(text);
  });

  it('looks up a session that is not loaded before listing it', async () => {
    getSession.mockResolvedValue(session('session_old', { workspaceId: API_WORKSPACE }));
    const text = `continue ${mention('session_old', 'Old work')}`;
    expect(hasUnresolvedSessionReferences(text)).toBe(true);
    expect(withSessionReferences(text)).toBe(text);

    await resolveSessionReferences(text);

    expect(getSession).toHaveBeenCalledExactlyOnceWith('session_old', { background: true });
    expect(hasUnresolvedSessionReferences(text)).toBe(false);
    expect(withSessionReferences(text)).toContain(`<session id="session_old" title="Old work" log="${logPath(API_WORKSPACE, 'session_old')}" />`);
  });

  it('leaves out sessions on a remote host and retries sessions it could not fetch', async () => {
    getSession.mockImplementation(async (id) => {
      if (id === 'remote_fetched') return session('remote_fetched', { hostId: 'devbox' });
      throw new Error('session not found');
    });
    const text = [
      mention('remote_loaded', 'Loaded remote'),
      mention('remote_fetched', 'Fetched remote'),
      mention('gone', 'Deleted'),
      mention('session_1', 'Here'),
    ].join(' ');

    await resolveSessionReferences(text);

    expect(getSession.mock.calls.map(([id]) => id).toSorted()).toEqual(['gone', 'remote_fetched']);
    const block = withSessionReferences(text).slice(text.length);
    expect(block).toContain('id="session_1"');
    expect(block).not.toMatch(/remote_loaded|remote_fetched|gone/);
    expect(hasUnresolvedSessionReferences(text)).toBe(true);
    expect(hasUnresolvedSessionReferences(mention('remote_fetched', 'Fetched remote'))).toBe(false);
  });

  it('lists sessions referenced with the earlier <workspaceId>/<sessionId> links', () => {
    const text = 'continue [Old](kimi-code://session/wd_app_0123456789ab/session_1)';
    expect(hasUnresolvedSessionReferences(text)).toBe(false);
    expect(withSessionReferences(text)).toContain(`<session id="session_1" title="Old" log="${logPath(APP_WORKSPACE, 'session_1')}" />`);
  });

  it('adds the references to the text part submitted to the server', () => {
    const parts = buildPromptContent({ text: `continue ${mention('session_1', 'Fix login')}`, attachments: [] });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.type === 'text' && parts[0].text).toContain(`log="${logPath(APP_WORKSPACE, 'session_1')}"`);
  });
});
