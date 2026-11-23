// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { clientPinia } from '@moonshot-ai/app-client/stores';
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

function mountRows(
  rows: Session[],
  options: { compactPinned?: boolean; showPinnedWorkspace?: boolean } = {},
): void {
  app = createApp({
    render: () =>
      h(
        'div',
        rows.map((row) =>
          h(SessionRow, {
            session: row,
            active: false,
            compactPinned: options.compactPinned,
            showPinnedWorkspace: options.showPinnedWorkspace,
          }),
        ),
      ),
  });
  app.use(clientPinia);
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

  it('keeps compact-pinned rows single-line with inline PR by default', () => {
    mountRows(
      [
        session({
          id: 'pinned-compact',
          pinned: true,
          workspaceName: 'example-project',
          cwdLabel: 'example-project',
          pullRequest: { number: 42, state: 'open', url: 'https://example.com/pull/42' },
        }),
      ],
      { compactPinned: true },
    );

    const row = host.querySelector('.se')!;
    expect(row.classList.contains('compact-pinned')).toBe(true);
    expect(row.classList.contains('has-sub')).toBe(false);
    expect(row.classList.contains('has-compact-pr')).toBe(true);
    expect(row.classList.contains('flat')).toBe(false);
    expect(row.querySelector('.lead-icon')).not.toBeNull();
    expect(row.querySelector('.sub')).toBeNull();
    expect(row.querySelector('.compact-pr')?.textContent).toContain('#42');
  });

  it('shows an iconless workspace subtitle on local compact-pinned rows when enabled and places PR in the subtitle', () => {
    mountRows(
      [
        session({
          id: 'pinned-local',
          pinned: true,
          workspaceName: 'example-project',
          cwdLabel: 'example-project',
          pullRequest: { number: 42, state: 'open', url: 'https://example.com/pull/42' },
        }),
      ],
      { compactPinned: true, showPinnedWorkspace: true },
    );

    const row = host.querySelector('.se')!;
    expect(row.classList.contains('compact-pinned')).toBe(true);
    expect(row.classList.contains('has-sub')).toBe(true);
    expect(row.classList.contains('flat')).toBe(false);
    expect(row.querySelector('.lead-icon')).not.toBeNull();
    expect(row.querySelector('.sub.sub--pinned')).not.toBeNull();
    expect(row.querySelector('.sub-icon')).toBeNull();
    expect(row.querySelector('.sub-text')?.textContent).toBe('example-project');
    expect(row.querySelector('.sub .pr')?.textContent).toContain('#42');
    expect(row.querySelector('.compact-pr')).toBeNull();
  });

  it('keeps the remote host icon in the subtitle for compact-pinned remote sessions when enabled', () => {
    mountRows(
      [
        session({
          id: 'pinned-remote',
          pinned: true,
          hostId: 'devbox',
          workspaceName: 'remote-repo',
          cwdLabel: 'remote-repo',
        }),
      ],
      { compactPinned: true, showPinnedWorkspace: true },
    );

    const row = host.querySelector('.se')!;
    expect(row.querySelector('.sub.sub--pinned .sub-icon')).not.toBeNull();
    expect(row.querySelector('.sub-text')?.textContent).toBe('remote-repo');
  });

  it('omits the subtitle and falls back to inline PR when a compact-pinned session has no workspace label', () => {
    mountRows(
      [
        session({
          id: 'pinned-dash',
          pinned: true,
          cwdLabel: '-',
          pullRequest: { number: 7, state: 'merged', url: 'https://example.com/pull/7' },
        }),
        session({
          id: 'pinned-none',
          pinned: true,
          cwdLabel: undefined,
        }),
      ],
      { compactPinned: true, showPinnedWorkspace: true },
    );

    const rows = host.querySelectorAll('.se');
    expect(rows[0]?.classList.contains('has-sub')).toBe(false);
    expect(rows[0]?.classList.contains('has-compact-pr')).toBe(true);
    expect(rows[0]?.querySelector('.sub')).toBeNull();
    expect(rows[0]?.querySelector('.compact-pr')?.textContent).toContain('#7');
    expect(rows[1]?.querySelector('.sub')).toBeNull();
    expect(rows[1]?.classList.contains('has-compact-pr')).toBe(false);
  });

  it('updates the compact-pinned subtitle when the workspace is renamed', async () => {
    const row = reactive(session({ pinned: true, workspaceName: 'Before', cwdLabel: 'repo' }));
    mountRows([row], { compactPinned: true, showPinnedWorkspace: true });
    row.workspaceName = 'After';
    await nextTick();

    expect(host.querySelector('.sub--pinned .sub-text')?.textContent).toBe('After');
  });

  it('hides the subtitle PR badge while renaming a compact-pinned row and keeps a tooltip on the subtitle', async () => {
    mountRows(
      [
        session({
          id: 'pinned-rename',
          pinned: true,
          workspaceName: 'long-project-name',
          cwdLabel: 'long-project-name',
          pullRequest: { number: 99, state: 'open', url: 'https://example.com/pull/99' },
        }),
      ],
      { compactPinned: true, showPinnedWorkspace: true },
    );

    const row = host.querySelector('.se')!;
    expect(row.querySelector('.sub-text')?.parentElement?.classList.contains('ui-tip')).toBe(true);
    expect(row.querySelector('.sub .pr')).not.toBeNull();

    row.querySelector('.t')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await nextTick();

    expect(row.querySelector('.rename-input')).not.toBeNull();
    expect(row.querySelector('.sub .pr')).toBeNull();
  });
});
