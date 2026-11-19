// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import SessionRow from '../src/SessionRow.vue';

let app: App | null = null;
let host: HTMLDivElement;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Session',
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    ...overrides,
  } as Session;
}

function mountRows(rows: Session[]): void {
  app = createApp({
    render: () => h('div', rows.map((row) => h(SessionRow, { session: row, active: false }))),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('SessionRow workspace label', () => {
  it('prefers the workspace name for flat and pinned rows', () => {
    mountRows([
      session({ id: 'flat', workspaceName: 'KC project 2', cwdLabel: 'code-app-2' }),
      session({ id: 'pinned', pinned: true, workspaceName: 'KC project 2', cwdLabel: 'code-app-2' }),
    ]);

    const labels = [...host.querySelectorAll('.sub-text')].map((el) => el.textContent);
    expect(labels).toEqual(['KC project 2', 'KC project 2']);
    expect(host.textContent).not.toContain('code-app-2');
  });

  it('falls back to the cwd label when the workspace name is missing', () => {
    mountRows([session({ cwdLabel: 'code-app-2' })]);

    expect(host.querySelector('.sub-text')?.textContent).toBe('code-app-2');
  });

  it('does not add a second line to grouped rows', () => {
    mountRows([session({ workspaceName: 'KC project 2', cwdLabel: undefined })]);

    expect(host.querySelector('.sub')).toBeNull();
  });

  it('updates the label when the workspace is renamed', async () => {
    const row = reactive(session({ workspaceName: 'Before', cwdLabel: 'code-app-2' }));
    mountRows([row]);
    row.workspaceName = 'After';
    await nextTick();

    expect(host.querySelector('.sub-text')?.textContent).toBe('After');
    expect(host.textContent).not.toContain('code-app-2');
  });

  it('uses different PR icons for open and merged states', () => {
    mountRows([
      session({ id: 'open', cwdLabel: 'repo', pullRequest: { number: 1, state: 'open', url: 'https://example.com/pull/1' } }),
      session({ id: 'merged', cwdLabel: 'repo', pullRequest: { number: 2, state: 'merged', url: 'https://example.com/pull/2' } }),
    ]);

    const icons = host.querySelectorAll('.pr svg');
    expect(icons).toHaveLength(2);
    expect(icons[0]?.outerHTML).not.toBe(icons[1]?.outerHTML);
  });
});
