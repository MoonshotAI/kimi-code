import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { formatSessionTabLabel, sessionTabTitle } from '#/tui/components/chrome/tab-strip';
import { SessionTabsController, type SessionTab } from '#/tui/controllers/session-tabs';
import { matchTabShortcut } from '#/tui/controllers/tab-shortcuts';
import type { TUIState } from '#/tui/tui-state';

type Listener = (event: Event) => void;

function makeSession(id: string, title: string | null = null) {
  const listeners = new Set<Listener>();
  return {
    id,
    summary: { title },
    onEvent: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit(event: Partial<Event> & { type: Event['type'] }): void {
      for (const listener of listeners) listener({ sessionId: id, agentId: 'main', ...event } as Event);
    },
    listenerCount: () => listeners.size,
  };
}

function makeHost() {
  const terminal = { write: vi.fn() };
  const state = {
    appState: { notifications: { enabled: true, condition: 'always' } },
    terminalState: {
      notificationKeys: new Set<string>(),
      focused: false,
      supportsOsc9: false,
      insideTmux: false,
    },
    terminal,
  } as unknown as TUIState;
  return {
    state,
    terminal,
    onTabsChanged: vi.fn(),
    onBackgroundTurnStarted: vi.fn(),
    onBackgroundTurnEnded: vi.fn(),
  };
}

function open(controller: SessionTabsController, session: ReturnType<typeof makeSession>): SessionTab {
  return controller.open(session as never);
}

describe('SessionTabsController', () => {
  it('registers tabs in order, activates one, and replaces in place', () => {
    const host = makeHost();
    const controller = new SessionTabsController(host);
    const a = open(controller, makeSession('a', 'Alpha'));
    const b = open(controller, makeSession('b'));
    expect(controller.size).toBe(2);
    expect(controller.active).toBeUndefined();

    controller.activate(a);
    expect(controller.active).toBe(a);
    expect(controller.activeTabIndex).toBe(0);
    expect(controller.find('b')).toBe(b);

    const c = controller.replace(a, makeSession('c') as never);
    expect(controller.all.map((tab) => tab.session.id)).toEqual(['c', 'b']);
    expect(controller.indexOf(c)).toBe(0);
    expect(a.title).toBe('Alpha');
    expect(host.onTabsChanged).toHaveBeenCalled();
  });

  it('watches a suspended tab and derives its state from background events', () => {
    const host = makeHost();
    const controller = new SessionTabsController(host);
    const session = makeSession('a');
    const tab = open(controller, session);
    controller.activate(tab);
    controller.stopWatching(tab);
    expect(session.listenerCount()).toBe(0);

    controller.suspend(tab, { draft: 'half typed', queuedMessages: [], running: true });
    expect(controller.active).toBeUndefined();
    expect(tab.status).toBe('running');
    expect(tab.draft).toBe('half typed');
    expect(session.listenerCount()).toBe(1);

    session.emit({ type: 'assistant.delta', turnId: 1, delta: 'hi' } as never);
    expect(tab.unread).toBe(true);

    session.emit({ type: 'session.meta.updated', title: 'Renamed', patch: { title: 'Renamed' } } as never);
    expect(tab.title).toBe('Renamed');

    session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' } as never);
    expect(tab.status).toBe('done');
    expect(host.onBackgroundTurnEnded).toHaveBeenCalledOnce();
    // The background turn raises the same terminal notification the foreground would.
    expect(host.state.terminalState.notificationKeys.has('turn-complete:a:1')).toBe(true);
    expect(host.terminal.write).toHaveBeenCalled();

    session.emit({ type: 'turn.started', turnId: 2 } as never);
    expect(tab.status).toBe('running');
    expect(host.onBackgroundTurnStarted).toHaveBeenCalledOnce();

    session.emit({ type: 'turn.ended', turnId: 2, reason: 'failed' } as never);
    expect(tab.status).toBe('error');

    // Re-activating clears the unread marker but keeps watching until the
    // host's own subscription is up.
    controller.activate(tab);
    expect(tab.unread).toBe(false);
    expect(session.listenerCount()).toBe(1);
    session.emit({ type: 'turn.started', turnId: 3 } as never);
    expect(tab.status).toBe('running');
    controller.stopWatching(tab);
    expect(session.listenerCount()).toBe(0);
  });

  it('marks a background tab as waiting when a request arrives, but not the active one', () => {
    const host = makeHost();
    const controller = new SessionTabsController(host);
    const active = open(controller, makeSession('a'));
    const background = open(controller, makeSession('b'));
    controller.activate(active);
    controller.suspend(background, { draft: '', queuedMessages: [], running: false });
    expect(background.status).toBe('idle');

    controller.noteRequestArrived(active, { key: 'approval:1', title: 'needs you' });
    expect(active.status).toBe('idle');
    expect(host.state.terminalState.notificationKeys.has('approval:1')).toBe(false);

    controller.noteRequestArrived(background, { key: 'approval:2', title: 'needs you' });
    expect(background.status).toBe('waiting');
    expect(background.unread).toBe(true);
    expect(host.state.terminalState.notificationKeys.has('approval:2')).toBe(true);
  });

  it('suspends as waiting when the tab already holds a pending request', async () => {
    const host = makeHost();
    const controller = new SessionTabsController(host);
    const tab = open(controller, makeSession('a'));
    controller.activate(tab);
    const pending = tab.approval.show({
      id: 'call-1',
      tool_call_id: 'call-1',
      tool_name: 'Shell',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    controller.suspend(tab, { draft: '', queuedMessages: [], running: false });
    expect(tab.status).toBe('waiting');

    // Removing the tab cancels what it still had queued.
    controller.remove(tab);
    await expect(pending).resolves.toMatchObject({ decision: 'cancelled' });
    expect(controller.size).toBe(0);
  });

  it('keeps the active index stable when another tab is removed', () => {
    const host = makeHost();
    const controller = new SessionTabsController(host);
    const a = open(controller, makeSession('a'));
    const b = open(controller, makeSession('b'));
    const c = open(controller, makeSession('c'));
    controller.activate(c);
    controller.suspend(a, { draft: '', queuedMessages: [], running: false });

    controller.remove(a);
    expect(controller.active).toBe(c);
    expect(controller.activeTabIndex).toBe(1);
    expect(controller.at(0)).toBe(b);

    controller.remove(c);
    expect(controller.active).toBeUndefined();
    expect(controller.activeTabIndex).toBe(-1);
  });
});

describe('session tab labels', () => {
  it('falls back to a short session id and marks state and unread', () => {
    expect(sessionTabTitle({ sessionId: 'abcdef0123456789', title: null })).toBe('abcdef01');
    expect(sessionTabTitle({ sessionId: 'x', title: '  Fix\n the  parser ' })).toBe('Fix the parser');
    expect(
      formatSessionTabLabel(0, { sessionId: 'x', title: 'Refactor', status: 'running', unread: false }),
    ).toBe('1● Refactor');
    expect(
      formatSessionTabLabel(2, { sessionId: 'x', title: 'Review', status: 'done', unread: true }),
    ).toBe('3✓ Review •');
    expect(
      formatSessionTabLabel(1, { sessionId: 'x', title: 'Ask', status: 'waiting', unread: true }),
    ).toBe('2⏸ Ask •');
    expect(formatSessionTabLabel(0, { sessionId: 'x', title: 'Idle', status: 'idle', unread: false })).toBe(
      '1 Idle',
    );
  });
});

describe('matchTabShortcut', () => {
  const ESC = '';

  it('maps Alt+digit, Alt+N / Alt+P, Alt+T and Alt+W', () => {
    expect(matchTabShortcut(`${ESC}1`)).toEqual({ kind: 'select', index: 0 });
    expect(matchTabShortcut(`${ESC}9`)).toEqual({ kind: 'select', index: 8 });
    expect(matchTabShortcut(`${ESC}n`)).toEqual({ kind: 'next' });
    expect(matchTabShortcut(`${ESC}p`)).toEqual({ kind: 'prev' });
    expect(matchTabShortcut(`${ESC}t`)).toEqual({ kind: 'new' });
    expect(matchTabShortcut(`${ESC}w`)).toEqual({ kind: 'close' });
  });

  it('maps Ctrl+Tab / Ctrl+Shift+Tab from the Kitty keyboard protocol', () => {
    expect(matchTabShortcut(`${ESC}[9;5u`)).toEqual({ kind: 'next' });
    expect(matchTabShortcut(`${ESC}[9;6u`)).toEqual({ kind: 'prev' });
  });

  it('ignores ordinary keys', () => {
    expect(matchTabShortcut('a')).toBeUndefined();
    expect(matchTabShortcut('\t')).toBeUndefined();
    expect(matchTabShortcut(`${ESC}0`)).toBeUndefined();
  });
});
