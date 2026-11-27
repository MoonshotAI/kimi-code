// @vitest-environment jsdom
import { nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';
import { clientPinia } from '@moonshot-ai/app-client/stores';
import SessionRow from '../src/SessionRow.vue';
import { cleanup, msg, render, screen, within, type Rendered } from './helpers/dom';

let rendered: Rendered;

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

function mountRow(row: Session, openInApp?: (url: string) => void): void {
  const state = reactive({ row });
  rendered = render(SessionRow, () => ({ session: state.row, active: false }), {
    plugins: [clientPinia],
    provide: openInApp === undefined ? [] : [[OpenSidebarBrowserUrlKey, () => openInApp]],
  });
}

const view = () => within(rendered.host);

function rowEl(): HTMLElement {
  return rendered.host.querySelector<HTMLElement>('.se')!;
}

function environmentIcon(key: string): HTMLElement | null {
  return view().queryAllByLabel(msg(key))[0] ?? null;
}

function card(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Fix login redirect' });
}

function follows(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('SessionRow environment indicator', () => {
  it('labels no environment for a local session and shows its time', () => {
    mountRow(session());

    expect(['worktreeSession.rowWorktree', 'worktreeSession.rowSettingUp', 'worktreeSession.rowInvalid'].map(environmentIcon)).toEqual([
      null,
      null,
      null,
    ]);
    expect(view().getByText('1h')).toBeTruthy();
    expect(rowEl().classList.contains('env-invalid')).toBe(false);
  });

  it('labels a worktree session with the worktree icon before the time', () => {
    mountRow(session({ environment: 'worktree' }));

    const icon = environmentIcon('worktreeSession.rowWorktree')!;
    expect(icon.getAttribute('data-icon')).toBe('git-fork');
    expect(follows(icon, view().getByText('1h'))).toBe(true);
  });

  it.each<[string, Partial<Session>, string]>([
    ['the session is running', { environment: 'worktree', busy: true }, 'worktreeSession.rowWorktree'],
    ['the worktree is being created', { environment: 'settingUp' }, 'worktreeSession.rowSettingUp'],
  ])('shows the worktree icon and then a spinner instead of the time while %s', (_label, overrides, key) => {
    mountRow(session(overrides));

    const icon = environmentIcon(key)!;
    const spinner = view().getByRole('status', { name: msg('common.loading') });
    expect(icon.getAttribute('data-icon')).toBe('git-fork');
    expect(follows(icon, spinner)).toBe(true);
    expect(view().queryByText('1h')).toBeNull();
  });

  it('slashes the icon and dims the title of an invalid worktree session', () => {
    mountRow(session({ environment: 'invalid' }));

    expect(environmentIcon('worktreeSession.rowInvalid')?.getAttribute('data-icon')).toBe('git-fork-off');
    expect(rowEl().classList.contains('env-invalid')).toBe(true);
  });
});

describe('SessionRow hover card', () => {
  it('opens after the pointer rests on the row for 500 ms and closes 140 ms after it leaves', async () => {
    vi.useFakeTimers();
    mountRow(session({ environment: 'worktree' }));

    rowEl().dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(499);
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(within(card()!).getByText('~/project')).toBeTruthy();

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
  const tag = () => view().getByRole('button', { name: 'PR #12' });

  it('opens the pull request in the built-in browser when one is available', () => {
    const openInApp = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountRow(session({ pullRequest, cwdLabel: 'project' }), openInApp);

    tag().click();
    expect(openInApp).toHaveBeenCalledExactlyOnceWith(pullRequest.url);
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to a new window without a built-in browser', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountRow(session({ pullRequest, cwdLabel: 'project' }));

    tag().click();
    expect(open).toHaveBeenCalledExactlyOnceWith(pullRequest.url, '_blank', 'noopener');
  });
});
