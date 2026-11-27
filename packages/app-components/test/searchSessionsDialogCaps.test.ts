// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import SearchSessionsDialog from '../src/dialogs/SearchSessionsDialog.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  document.body.innerHTML = '';
});

function workspace(i: number): WorkspaceView {
  return {
    id: `wd_${i}`,
    name: `project-${i}`,
    root: `/home/x/project-${i}`,
    shortPath: `~/project-${i}`,
    sessionCount: 1,
  } as unknown as WorkspaceView;
}

function session(i: number): Session {
  return {
    id: `s_${i}`,
    title: `project session ${i}`,
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceName: `project-${i}`,
  } as unknown as Session;
}

async function mountDialog(workspaceCount: number, sessionCount = 0): Promise<void> {
  const workspaces = Array.from({ length: workspaceCount }, (_, i) => workspace(i));
  const sessions = Array.from({ length: sessionCount }, (_, i) => session(i));
  app = createApp({
    render: () => h(SearchSessionsDialog, { sessions, workspaces, activeId: '' }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await nextTick();
}

async function search(query: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.sd-search input');
  expect(input).not.toBeNull();
  input!.value = query;
  input!.dispatchEvent(new Event('input'));
  await nextTick();
  await nextTick();
}

function workspaceRows(): number {
  return document.querySelectorAll('.sd-row-ws').length;
}

describe('SearchSessionsDialog workspace paths', () => {
  it('matches and highlights a Windows workspace path whichever slash the query uses', async () => {
    const windows = { id: 'wd_win', name: 'app', root: 'C:/Users/me/code/app', shortPath: '~\\code\\app', sessionCount: 1 } as unknown as WorkspaceView;
    app = createApp({ render: () => h(SearchSessionsDialog, { sessions: [], workspaces: [windows], activeId: '' }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    await search('code/app');
    expect(workspaceRows()).toBe(1);
    expect(document.querySelector('.sd-ws-path')?.innerHTML).toBe('~\\<mark>code\\app</mark>');
  });
});

describe('SearchSessionsDialog result caps', () => {
  it('shows only the first few workspaces before a query is typed', async () => {
    await mountDialog(300);
    expect(workspaceRows()).toBe(3);
  });

  it('caps workspace matches for a broad query', async () => {
    await mountDialog(300, 5);
    await search('project');
    expect(workspaceRows()).toBe(50);
    expect(document.querySelectorAll('.sd-row:not(.sd-row-ws)').length).toBe(5);
  });

  it('keeps every workspace match when a query is specific enough', async () => {
    await mountDialog(300);
    await search('project-12');
    expect(workspaceRows()).toBe(11);
  });
});
