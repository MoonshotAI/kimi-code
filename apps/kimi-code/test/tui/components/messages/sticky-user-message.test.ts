import { visibleWidth, type TuiMouseEvent, type TuiMouseEventType } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { StickyUserMessageComponent } from '#/tui/components/messages/sticky-user-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { currentTheme } from '#/tui/theme';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function judgment(summary: string, targetY = 2) {
  return { component: { render: vi.fn(() => []), invalidate() {} }, summary, targetY };
}

function mouseEvent(type: TuiMouseEventType): TuiMouseEvent {
  return {
    type,
    button: type === 'wheel' ? 'none' : 'left',
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe('StickyUserMessageComponent', () => {
  it('takes no row when hidden and displays the supplied summary with its bullet', () => {
    const component = new StickyUserMessageComponent(() => {});
    expect(component.render(80)).toEqual([]);
    const state = judgment('one two');
    expect(component.setJudgment(state)).toBe(true);
    expect(component.render(80).map(stripAnsi)).toEqual(['❯ one two']);
    expect(state.component.render).not.toHaveBeenCalled();
    expect(component.setJudgment({ ...state })).toBe(false);
    expect(component.setJudgment(null)).toBe(true);
    expect(component.render(80)).toEqual([]);
    expect(component.setJudgment(null)).toBe(false);
  });

  it('keeps the user message skill highlighting in a Fullscreen summary', () => {
    const summary = '/skill:review check src/app.ts';
    const user = new UserMessageComponent(summary, undefined, undefined, ['review']);
    const component = new StickyUserMessageComponent(() => {});
    component.setJudgment({ component: user, summary, targetY: 2 });

    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const line = component.render(80)[0]!;
      expect(stripAnsi(line)).toBe(`❯ ${summary}`);
      expect(line).toContain(currentTheme.boldFg('primary', '/skill:review'));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('truncates long summaries to one row and supports narrow widths', () => {
    const component = new StickyUserMessageComponent(() => {});
    component.setJudgment(judgment('word '.repeat(200).trim()));
    expect(stripAnsi(component.render(20)[0]!).endsWith('…')).toBe(true);
    for (const width of [1, 2, 4, 10, 39]) {
      const lines = component.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
    }
    expect(component.render(0)).toEqual([]);
  });

  it('keeps wide characters and emoji intact when truncating a long message', () => {
    const component = new StickyUserMessageComponent(() => {});
    component.setJudgment(judgment('中文 👩‍💻 details '.repeat(1000)));
    const lines = component.render(11);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe('❯ 中文 👩‍💻 …');
    expect(visibleWidth(lines[0]!)).toBe(11);
  });

  it('uses the latest jump target even when the displayed summary is unchanged', () => {
    const scrollTo = vi.fn();
    const component = new StickyUserMessageComponent(scrollTo);
    const state = judgment('hello', 6);
    component.setJudgment(state);
    expect(component.handleMouse(mouseEvent('click'))).toEqual({ handled: true });
    expect(scrollTo).toHaveBeenLastCalledWith(6);
    expect(component.setJudgment({ ...state, targetY: 9 })).toBe(true);
    component.handleMouse(mouseEvent('click'));
    expect(scrollTo).toHaveBeenLastCalledWith(9);
    expect(component.setJudgment(judgment('hello', 9))).toBe(true);
  });

  it('lets wheel input pass through and ignores clicks while hidden', () => {
    const scrollTo = vi.fn();
    const component = new StickyUserMessageComponent(scrollTo);
    expect(component.handleMouse(mouseEvent('click'))).toBeUndefined();
    component.setJudgment(judgment('hello'));
    expect(component.handleMouse(mouseEvent('wheel'))).toBeUndefined();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
