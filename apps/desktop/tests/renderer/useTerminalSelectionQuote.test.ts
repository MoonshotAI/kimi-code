import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSelectionQuoteEnabledForTests } from '@moonshot-ai/app-composer/model';
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';

import { useTerminalSelectionQuote } from '../../src/renderer/composables/useTerminalSelectionQuote';

function makeTerm(selection = '') {
  let listeners: Array<() => void> = [];
  const term = {
    selection,
    hasSelection: vi.fn(() => term.selection.length > 0),
    getSelection: vi.fn(() => term.selection),
    clearSelection: vi.fn(() => {
      term.selection = '';
    }),
    onSelectionChange: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          listeners = listeners.filter((l) => l !== listener);
        },
      };
    }),
    emitSelectionChange: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.length,
  };
  return term;
}

function mouseup(button = 0, clientX = 100, clientY = 50): MouseEvent {
  return { button, clientX, clientY } as MouseEvent;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  setSelectionQuoteEnabledForTests(true);
});

describe('useTerminalSelectionQuote', () => {
  it('pops the bubble at the pointer on left mouseup with an active selection', async () => {
    const term = makeTerm('\nhello world\n');
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });
    bridge.attach(term);

    bridge.onHostMouseup(mouseup(0, 120, 64));
    await flush();

    expect(bridge.anchor.value).toEqual({ x: 120, y: 64, bottom: 64, px: 120, py: 64, quote: 'hello world' });
  });

  it('stays hidden when the release gate is off', async () => {
    setSelectionQuoteEnabledForTests(false);
    const term = makeTerm('hello');
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });
    bridge.attach(term);

    bridge.onHostMouseup(mouseup());
    await flush();

    expect(bridge.anchor.value).toBeNull();
  });

  it('stays hidden for empty or whitespace-only selections and non-left buttons', async () => {
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });

    const empty = makeTerm('');
    bridge.attach(empty);
    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).toBeNull();

    const blank = makeTerm('\n  \n');
    bridge.attach(blank);
    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).toBeNull();

    const term = makeTerm('hello');
    bridge.attach(term);
    bridge.onHostMouseup(mouseup(2));
    await flush();
    expect(bridge.anchor.value).toBeNull();
  });

  it('does not re-pop after dismiss until the selection changes', async () => {
    const term = makeTerm('hello');
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });
    bridge.attach(term);

    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).not.toBeNull();

    bridge.onBubbleClose();
    expect(bridge.anchor.value).toBeNull();

    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).toBeNull();

    term.emitSelectionChange();
    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).not.toBeNull();
  });

  it('hides the bubble when the selection collapses', async () => {
    const term = makeTerm('hello');
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });
    bridge.attach(term);

    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).not.toBeNull();

    term.selection = '';
    term.emitSelectionChange();
    expect(bridge.anchor.value).toBeNull();
  });

  it('forwards the action payload, clears the xterm selection, and hides', async () => {
    const term = makeTerm('hello');
    const onAction = vi.fn();
    const bridge = useTerminalSelectionQuote({ onAction });
    bridge.attach(term);

    bridge.onHostMouseup(mouseup());
    await flush();

    const payload: SelectionActionPayload = { action: 'comment', quote: 'hello', comment: 'note' };
    bridge.onBubbleAction(payload);

    expect(onAction).toHaveBeenCalledWith(payload);
    expect(term.clearSelection).toHaveBeenCalled();
    expect(bridge.anchor.value).toBeNull();
  });

  it('detach disposes the selection listener and resets state', async () => {
    const term = makeTerm('hello');
    const bridge = useTerminalSelectionQuote({ onAction: vi.fn() });
    bridge.attach(term);
    expect(term.listenerCount()).toBe(1);

    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).not.toBeNull();

    bridge.detach();
    expect(bridge.anchor.value).toBeNull();
    expect(term.listenerCount()).toBe(0);

    bridge.onHostMouseup(mouseup());
    await flush();
    expect(bridge.anchor.value).toBeNull();
  });
});
