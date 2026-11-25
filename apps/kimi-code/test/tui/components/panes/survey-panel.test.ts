import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth, type TuiMouseEvent } from '@moonshot-ai/pi-tui';

import {
  SurveyPanelComponent,
  type SurveyPanelView,
} from '#/tui/components/panes/survey-panel';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function mouseEvent(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
    ...(wheelDelta !== undefined ? { wheelDelta } : {}),
  };
}

function render(view: SurveyPanelView, width: number): string[] {
  return new SurveyPanelComponent(view).render(width).map(stripAnsi);
}

describe('SurveyPanelComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('renders the question and the four options on one line', () => {
    const lines = render({ phase: 'open' }, 80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('●');
    expect(lines[0]).toContain('How is Kimi doing this session? (optional)');
    expect(lines[1]).toBe('  1: Bad  2: Fine  3: Good  0: Dismiss');
  });

  it('folds the options onto their own lines when narrow', () => {
    const lines = render({ phase: 'open' }, 30);
    expect(lines[0]).toContain('How is Kimi doing this');
    expect(lines[1]).toContain('session? (optional)');
    expect(lines.slice(2)).toEqual(['  1: Bad', '  2: Fine', '  3: Good', '  0: Dismiss']);
  });

  it('keeps only the title line at extreme widths, without hard-breaking', () => {
    const width = 10;
    const lines = render({ phase: 'open' }, width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines.join('\n')).not.toContain('1: Bad');
    expect(lines[0]).toContain('●');
  });

  it('renders the pending line with the chosen rating and the undo hint', () => {
    const lines = render({ phase: 'pending', response: 'bad' }, 80);
    expect(lines).toEqual(['● Feedback: Bad · [escape: undo]']);
  });

  it('renders the thanks line', () => {
    const lines = render({ phase: 'thanks' }, 80);
    expect(lines).toEqual(['● Thanks for your feedback!']);
  });

  it('highlights the hovered option', () => {
    const plain = new SurveyPanelComponent({ phase: 'open' }).render(80)[1]!;
    const hovered = new SurveyPanelComponent({ phase: 'open', hoverIndex: 2 }).render(80)[1]!;
    expect(stripAnsi(hovered)).toBe(stripAnsi(plain));
    expect(hovered).not.toBe(plain);
    expect(hovered).toContain('3: Good');
  });

  it('renders a single blank line when the terminal cannot hold a column', () => {
    expect(render({ phase: 'open' }, 0)).toEqual(['']);
  });

  it('activates options on click in wide layout without stealing focus or mutating hoverIndex on move', () => {
    const view: SurveyPanelView = { phase: 'open' };
    const onSelectOption = vi.fn();
    const onUndo = vi.fn();
    const panel = new SurveyPanelComponent(view, { onSelectOption, onUndo });
    const lines = panel.render(80).map(stripAnsi);
    const optionsRow = 1;
    const labels = ['1: Bad', '2: Fine', '3: Good', '0: Dismiss'];

    for (let index = 0; index < labels.length; index++) {
      const col = lines[optionsRow]!.indexOf(labels[index]!);
      expect(panel.handleMouse(mouseEvent('move', col, optionsRow))).toBeUndefined();
      expect(view.hoverIndex).toBeUndefined();
    }

    expect(panel.handleMouse(mouseEvent('wheel', 4, optionsRow, 1))).toBeUndefined();
    expect(panel.handleMouse(mouseEvent('click', 4, 0))).toBeUndefined();
    expect(panel.handleMouse(mouseEvent('click', 0, optionsRow))).toBeUndefined();

    const fineCol = lines[optionsRow]!.indexOf('2: Fine');
    const dismissCol = lines[optionsRow]!.indexOf('0: Dismiss');
    const gapCol = lines[optionsRow]!.indexOf('1: Bad') + '1: Bad'.length;
    expect(panel.handleMouse(mouseEvent('click', gapCol, optionsRow))).toBeUndefined();

    const pressResult = panel.handleMouse(mouseEvent('press', fineCol, optionsRow));
    expect(pressResult).toEqual({ handled: true, render: false });
    expect(pressResult?.focus).toBeUndefined();

    const clickResult = panel.handleMouse(mouseEvent('click', fineCol, optionsRow));
    expect(clickResult).toEqual({ handled: true, render: true });
    expect(clickResult?.focus).toBeUndefined();
    expect(onSelectOption).toHaveBeenCalledWith(1);
    expect(view.hoverIndex).toBeUndefined();

    panel.handleMouse(mouseEvent('press', fineCol, optionsRow));
    expect(panel.handleMouse(mouseEvent('click', dismissCol, optionsRow))).toEqual({
      handled: true,
    });
    expect(onSelectOption).toHaveBeenCalledTimes(1);
  });

  it('activates folded options on click in narrow layout and ignores extreme narrow width', () => {
    const view: SurveyPanelView = { phase: 'open' };
    const onSelectOption = vi.fn();
    const panel = new SurveyPanelComponent(view, { onSelectOption });
    const narrowLines = panel.render(30).map(stripAnsi);
    const goodRow = narrowLines.findIndex((line) => line.includes('3: Good'));
    const goodCol = narrowLines[goodRow]!.indexOf('3: Good');

    expect(panel.handleMouse(mouseEvent('move', goodCol, goodRow))).toBeUndefined();
    expect(view.hoverIndex).toBeUndefined();

    const pressResult = panel.handleMouse(mouseEvent('press', goodCol, goodRow));
    const clickResult = panel.handleMouse(mouseEvent('click', goodCol, goodRow));
    expect(pressResult?.focus).toBeUndefined();
    expect(clickResult).toEqual({ handled: true, render: true });
    expect(clickResult?.focus).toBeUndefined();
    expect(onSelectOption).toHaveBeenCalledWith(2);

    panel.render(10);
    expect(panel.handleMouse(mouseEvent('click', 2, 0))).toBeUndefined();
    expect(onSelectOption).toHaveBeenCalledTimes(1);
  });

  it('activates undo on click in pending phase and ignores clicks in thanks phase', () => {
    const view: SurveyPanelView = { phase: 'pending', response: 'bad' };
    const onUndo = vi.fn();
    const panel = new SurveyPanelComponent(view, { onUndo });
    const [pendingLine] = panel.render(80).map(stripAnsi);
    const undoCol = pendingLine!.indexOf('[escape: undo]');

    expect(panel.handleMouse(mouseEvent('move', undoCol, 0))).toBeUndefined();
    expect(panel.handleMouse(mouseEvent('click', 3, 0))).toBeUndefined();

    const pressResult = panel.handleMouse(mouseEvent('press', undoCol, 0));
    const clickResult = panel.handleMouse(mouseEvent('click', undoCol, 0));
    expect(pressResult?.focus).toBeUndefined();
    expect(clickResult).toEqual({ handled: true, render: true });
    expect(clickResult?.focus).toBeUndefined();
    expect(onUndo).toHaveBeenCalledTimes(1);

    view.phase = 'thanks';
    panel.render(80);
    expect(panel.handleMouse(mouseEvent('click', undoCol, 0))).toBeUndefined();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
