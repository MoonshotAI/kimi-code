import { visibleWidth, type TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { PinnedUserMessageComponent } from '#/tui/components/messages/pinned-user-message';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

/** Minimal TUI stub: the component only reads scroll state. */
function makeTuiStub(viewportTop: number): { tui: TUI; setViewportTop(top: number): void } {
  const state = { viewportTop };
  return {
    tui: {
      getViewportTop: () => state.viewportTop,
      getContentHeight: () => 0,
    } as unknown as TUI,
    setViewportTop: (top: number) => {
      state.viewportTop = top;
    },
  };
}

describe('PinnedUserMessageComponent', () => {
  it('renders nothing before any message is pinned', () => {
    const { tui } = makeTuiStub(100);
    const component = new PinnedUserMessageComponent(tui, () => true);

    expect(component.render(80)).toEqual([]);
  });

  it('stays hidden while the original message is still inside the viewport', () => {
    // Message anchored at line 10 with height 2 (1 text row + 1 spacer row):
    // it has only scrolled off once viewportTop passes line 12.
    const { tui } = makeTuiStub(12);
    const component = new PinnedUserMessageComponent(tui, () => true);
    component.setMessage('hello world', 10);

    expect(component.render(80)).toEqual([]);
  });

  it('shows the pinned message with a divider once it scrolled above the viewport', () => {
    const { tui, setViewportTop } = makeTuiStub(0);
    const component = new PinnedUserMessageComponent(tui, () => true);
    component.setMessage('add the incident to the changelog', 10);

    setViewportTop(100);
    const lines = component.render(80);

    expect(lines).toHaveLength(2);
    const plain = stripAnsi(lines[0]!);
    expect(plain).toContain('✨');
    expect(plain).toContain('add the incident to the changelog');
    // Full-width rows: the transcript underneath is fully occluded.
    expect(visibleWidth(lines[0]!)).toBe(80);
    // A thin rule separates the pin from the scrolling transcript.
    expect(stripAnsi(lines[1]!)).toBe('─'.repeat(80));
  });

  it('caps long messages at three lines with an ellipsis', () => {
    const { tui } = makeTuiStub(1000);
    const component = new PinnedUserMessageComponent(tui, () => true);
    component.setMessage(
      'word '.repeat(200).trim(),
      10,
    );

    const lines = component.render(40);

    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[2]!)).toContain('…');
    expect(stripAnsi(lines[3]!)).toBe('─'.repeat(40));
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(40);
    }
  });

  it('renders nothing when the feature is disabled', () => {
    const { tui } = makeTuiStub(1000);
    const component = new PinnedUserMessageComponent(tui, () => false);
    component.setMessage('hello world', 10);

    expect(component.render(80)).toEqual([]);
  });

  it('hides again after clear()', () => {
    const { tui } = makeTuiStub(1000);
    const component = new PinnedUserMessageComponent(tui, () => true);
    component.setMessage('hello world', 10);
    expect(component.render(80)).not.toEqual([]);

    component.clear();
    expect(component.render(80)).toEqual([]);
  });

  it('updates the snapshot when a new message is pinned', () => {
    const { tui } = makeTuiStub(1000);
    const component = new PinnedUserMessageComponent(tui, () => true);
    component.setMessage('first message', 10);
    component.setMessage('second message', 500);

    const out = stripAnsi(component.render(80).join('\n'));
    expect(out).toContain('second message');
    expect(out).not.toContain('first message');
  });
});
