import { ANIMATION_FRAME_INTERVAL_MS, AnimationFrameScheduler, visibleWidth, type TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';

const defaultChalkLevel = chalk.level;

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

function frameUi() {
  const frames = new AnimationFrameScheduler();
  const requestRender = vi.fn();
  const ui = {
    requestRender,
    requestAnimationFrame: (callback: (time: number) => void) => frames.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle: number) => {
      frames.cancelAnimationFrame(handle);
    },
  } as unknown as TUI;
  return { ui, requestRender };
}

describe('ThinkingComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    chalk.level = defaultChalkLevel;
  });

  it('shows a Thinking title above the indented live preview', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const lines = component.render(80).map(strip);

    expect(lines[1]).toBe('● Thinking');
    expect(lines.join('\n')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(lines[2]?.trimEnd()).toBe('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('leaves trailing blank lines out of the live preview', () => {
    const component = new ThinkingComponent('line1\nline2\nline3\n\n', true, 'live');
    const lines = component.render(80).map((line) => strip(line).trimEnd());

    expect(lines).toEqual(['', '● Thinking', '  line2', '  line3']);
  });

  it('shows elapsed seconds after two seconds of thinking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const component = new ThinkingComponent('step', true, 'live');

    vi.setSystemTime(101_999);
    expect(strip(component.render(80)[1] ?? '')).toBe('● Thinking');

    vi.setSystemTime(102_000);
    component.setText('step two');
    expect(strip(component.render(80)[1] ?? '')).toBe('● Thinking · 2s');
  });

  it('sweeps the live title only on animation frames and stops requesting frames on finalize', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { ui, requestRender } = frameUi();
    const component = new ThinkingComponent('step', true, 'live', ui);
    const initial = component.render(80)[1];

    vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS / 2);
    expect(component.render(80)[1]).toBe(initial);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS / 2);
    expect(requestRender).toHaveBeenCalledTimes(1);
    const swept = component.render(80)[1];
    expect(swept).not.toBe(initial);
    expect(strip(swept ?? '')).toBe('● Thinking');

    component.finalize({ known: true, ms: 1_000 });
    expect(vi.getTimerCount()).toBe(0);
    requestRender.mockClear();
    vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS * 4);
    expect(requestRender).not.toHaveBeenCalled();
    const finalizedOnly = new ThinkingComponent('step', true, 'finalized');
    finalizedOnly.finalize({ known: true, ms: 1_000 });
    expect(component.render(80)).toEqual(finalizedOnly.render(80));
    expect(component.render(80).map((line) => strip(line).trimEnd())).toEqual(['', '● step']);
  });

  it('stops requesting animation frames on dispose', () => {
    vi.useFakeTimers();
    const component = new ThinkingComponent('step', true, 'live', frameUi().ui);
    expect(vi.getTimerCount()).toBe(1);

    component.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');

    component.finalize({ known: false });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('… (5 more lines, ctrl+o to expand)');
  });

  it('keeps every line in place under the given title when an opened thought finishes', () => {
    const component = new ThinkingComponent(`${longThinking}\n\n`, true, 'live');
    component.setExpanded(true);
    const live = component.render(80);
    component.setFinishedForm({ kind: 'opened', title: 'Thought for 5s' });
    expect(component.render(80)).toEqual(live);

    component.finalize({ known: true, ms: 5_000 });
    const finished = component.render(80);
    expect(finished.map((line) => strip(line).trimEnd())).toEqual([
      '',
      '● Thought for 5s',
      '  line1',
      '  line2',
      '  line3',
      '  line4',
      '  line5',
      '  line6',
      '  line7',
    ]);
    expect(finished.slice(2)).toEqual(live.slice(2));
    component.setFinishedForm({ kind: 'opened', title: 'Thought for 5s' });
    expect(component.render(80)).toBe(finished);

    component.setFinishedForm({ kind: 'standalone' });
    component.setExpanded(false);
    expect(strip(component.render(80).join('\n'))).toContain('● line1');
    expect(strip(component.render(80).join('\n'))).toContain('ctrl+o to expand');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize({ known: false });

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('keeps the finalized truncation footer within the requested render width', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize({ known: false });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('shows a single overflow line instead of swapping it for a same-height hint', () => {
    const component = new ThinkingComponent(['line1', 'line2', 'line3'].join('\n'), true, 'live');
    component.finalize({ known: false });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).toContain('line3');
    expect(out).not.toContain('more lines');
    expect(component.hasHiddenContent()).toBe(false);
  });

  it('collapses once folding saves at least one row', () => {
    const component = new ThinkingComponent(
      ['line1', 'line2', 'line3', 'line4'].join('\n'),
      true,
      'live',
    );
    component.finalize({ known: false });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).toContain('… (2 more lines, ctrl+o to expand)');
    expect(component.hasHiddenContent()).toBe(true);
  });
});
