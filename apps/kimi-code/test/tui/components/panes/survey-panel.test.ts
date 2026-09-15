import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { visibleWidth } from '@moonshot-ai/pi-tui';

import {
  SurveyPanelComponent,
  type SurveyPanelView,
} from '#/tui/components/panes/survey-panel';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
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
});
