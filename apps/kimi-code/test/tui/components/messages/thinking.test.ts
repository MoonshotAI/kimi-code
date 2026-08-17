import { visibleWidth, type TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows the live spinner header before thinking content', () => {
    const component = new ThinkingComponent('working it out', true, { mode: 'live' });
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ thinking...');
    expect(out).not.toContain('  ⠋ thinking...');
    expect(out).not.toContain(`${STATUS_BULLET}⠋`);
    expect(out).toContain('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live' });
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('animates the live spinner and stops on finalize', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new ThinkingComponent('step', true, {
      mode: 'live',
      ui: { requestRender } as unknown as TUI,
    });

    expect(strip(component.render(80).join('\n'))).toContain('⠋ thinking...');

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalled();
    expect(strip(component.render(80).join('\n'))).toContain('⠙ thinking...');

    component.finalize();
    requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(requestRender).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live' });

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('... (5 more lines, ctrl+o to expand)');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live' });
    component.finalize();

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
    const component = new ThinkingComponent(longThinking, true, { mode: 'live' });
    component.finalize();

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('shows approx tokens and elapsed time instead of content in live stats mode', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live', liveDisplay: 'stats' });
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ thinking...');
    // longThinking is 41 chars → ceil(41 / 4) = 11 approximate tokens.
    expect(out).toContain('~11 tokens');
    expect(out).toContain('0s');
    expect(out).not.toContain('line6');
    expect(out).not.toContain('line7');
  });

  it('ticks the elapsed time in live stats mode', () => {
    vi.useFakeTimers();
    const component = new ThinkingComponent('working it out', true, { mode: 'live', liveDisplay: 'stats' });

    vi.advanceTimersByTime(72_000);
    component.invalidate();
    expect(strip(component.render(80).join('\n'))).toContain('1m12s');

    vi.advanceTimersByTime(18_213_000 - 72_000);
    component.invalidate();
    expect(strip(component.render(80).join('\n'))).toContain('5h3m33s');

    vi.useRealTimers();
  });

  it('finalizes stats mode into a "Thought for" summary line', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live', liveDisplay: 'stats' });

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain(`${STATUS_BULLET}Thought for 0s`);
    expect(out).toContain('(ctrl+o to expand)');
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line7');
  });

  it('freezes the elapsed time in the stats summary on finalize', () => {
    vi.useFakeTimers();
    const component = new ThinkingComponent('working it out', true, { mode: 'live', liveDisplay: 'stats' });

    vi.advanceTimersByTime(72_000);
    component.finalize();
    expect(strip(component.render(80).join('\n'))).toContain('Thought for 1m12s');

    vi.advanceTimersByTime(60_000);
    component.invalidate();
    expect(strip(component.render(80).join('\n'))).toContain('Thought for 1m12s');

    vi.useRealTimers();
  });

  it('expands a finalized stats summary into the full thinking text', () => {
    const component = new ThinkingComponent(longThinking, true, { mode: 'live', liveDisplay: 'stats' });
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('Thought for');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).toContain('Thought for 0s');
    expect(collapsed).not.toContain('line7');
  });

  it('shows "Thought for a while" for untimed (replayed) stats blocks', () => {
    const component = new ThinkingComponent(longThinking, true, {
      mode: 'live',
      liveDisplay: 'stats',
      timed: false,
    });

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain(`${STATUS_BULLET}Thought for a while`);
    expect(out).toContain('(ctrl+o to expand)');
    expect(out).not.toContain('0s');
    expect(out).not.toContain('line1');
  });

  it('omits the elapsed time from the untimed live stats line', () => {
    const component = new ThinkingComponent('working it out', true, {
      mode: 'live',
      liveDisplay: 'stats',
      timed: false,
    });

    const out = strip(component.render(80).join('\n'));
    // 'working it out' is 14 chars → ceil(14 / 4) = 4 approximate tokens.
    expect(out).toContain('thinking... (~4 tokens)');
    expect(out).not.toContain('0s');
  });
});
