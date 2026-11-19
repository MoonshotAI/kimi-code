// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { clientPinia } from '@moonshot-ai/app-client/stores';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import SessionRow from '../src/SessionRow.vue';
import sessionRowSource from '../src/SessionRow.vue?raw';

let app: App | null = null;
let host: HTMLDivElement;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Fix login redirect',
    time: '1h',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/Users/me/project',
    ...overrides,
  } as Session;
}

function mountRow(row: Session, openInApp?: (url: string) => void): { row: Session } {
  const state = reactive({ row });
  app = createApp({
    setup() {
      return () => h(SessionRow, { session: state.row, active: false });
    },
  });
  app.use(clientPinia);
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => ({
    render: () => h('svg', { 'data-icon': name }),
  }));
  if (openInApp !== undefined) app.provide(OpenSidebarBrowserUrlKey, () => openInApp);
  app.mount(host);
  return state;
}

function rowEl(): HTMLElement {
  return host.querySelector<HTMLElement>('.se')!;
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-session-hover-card]');
}

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('SessionRow environment indicator', () => {
  it('shows no icon for a local session', () => {
    mountRow(session());

    expect(host.querySelector('.wt')).toBeNull();
    expect(host.querySelector('.ts')?.textContent).toBe('1h');
    expect(rowEl().classList.contains('env-invalid')).toBe(false);
  });

  it('shows the worktree icon left of the date', () => {
    mountRow(session({ environment: 'worktree' }));

    const icon = host.querySelector<HTMLElement>('.act .wt')!;
    expect(icon.getAttribute('data-environment')).toBe('worktree');
    expect(icon.querySelector('[data-icon="git-fork"]')).not.toBeNull();
    expect(icon.nextElementSibling?.classList.contains('ts')).toBe(true);
  });

  it('shows the worktree icon and a spinner while the session is running', () => {
    mountRow(session({ environment: 'worktree', busy: true }));

    const icon = host.querySelector<HTMLElement>('.act .wt')!;
    expect(icon.nextElementSibling?.classList.contains('st')).toBe(true);
    expect(host.querySelector('.st .ui-spinner')).not.toBeNull();
    expect(host.querySelector('.ts')).toBeNull();
  });

  it('shows the worktree icon and a spinner while the worktree is being created', () => {
    mountRow(session({ environment: 'settingUp' }));

    expect(host.querySelector('.act .wt [data-icon="git-fork"]')).not.toBeNull();
    expect(host.querySelector('.st .ui-spinner')).not.toBeNull();
    expect(host.querySelector('.ts')).toBeNull();
  });

  it('slashes the icon and dims the title of an invalid worktree session', () => {
    mountRow(session({ environment: 'invalid' }));

    expect(host.querySelector('.act .wt [data-icon="git-fork-off"]')).not.toBeNull();
    expect(rowEl().classList.contains('env-invalid')).toBe(true);
  });

  it('replaces the icon and date with the row actions on hover', () => {
    expect(sessionRowSource).toMatch(/\.se:hover \.act \.wt \{\s*opacity: 0;\s*visibility: hidden;/);
    expect(sessionRowSource).toMatch(/\.se:hover \.act \.ts \{\s*opacity: 0;\s*visibility: hidden;/);
    expect(sessionRowSource).toMatch(/\.se:hover \.ha \{\s*opacity: 1;\s*visibility: visible;/);
  });
});

describe('SessionRow hover card', () => {
  it('opens after the pointer rests on the row for 500 ms and closes after it leaves', async () => {
    vi.useFakeTimers();
    mountRow(session({ environment: 'worktree' }));

    rowEl().dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(499);
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(card()?.querySelector('.shc-title')?.textContent).toBe('Fix login redirect');
    expect(card()?.querySelector('.shc-path')?.textContent).toBe('~/project');

    rowEl().dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(139);
    expect(card()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(card()).toBeNull();
  });

  it('stays closed when the pointer leaves before the delay', async () => {
    vi.useFakeTimers();
    mountRow(session());

    rowEl().dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(300);
    rowEl().dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(card()).toBeNull();
  });

  it('stays open while the pointer is over the card and closes when the row is selected', async () => {
    vi.useFakeTimers();
    mountRow(session());

    rowEl().dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(500);
    await nextTick();
    rowEl().dispatchEvent(new MouseEvent('mouseleave'));
    card()!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(card()).not.toBeNull();

    rowEl().click();
    await nextTick();
    expect(card()).toBeNull();
  });
});

describe('SessionRow pull request tag', () => {
  const pullRequest = { number: 12, state: 'open' as const, url: 'https://github.com/acme/repo/pull/12' };

  it('opens the pull request in the built-in browser when one is available', () => {
    const openInApp = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountRow(session({ pullRequest, cwdLabel: 'project' }), openInApp);

    host.querySelector<HTMLButtonElement>('.pr')!.click();
    expect(openInApp).toHaveBeenCalledExactlyOnceWith(pullRequest.url);
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to a new window without a built-in browser', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountRow(session({ pullRequest, cwdLabel: 'project' }));

    host.querySelector<HTMLButtonElement>('.pr')!.click();
    expect(open).toHaveBeenCalledExactlyOnceWith(pullRequest.url, '_blank', 'noopener');
  });
});
