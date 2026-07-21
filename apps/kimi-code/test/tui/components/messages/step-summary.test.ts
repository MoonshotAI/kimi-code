import { describe, expect, it } from 'vitest';

import { StepSummaryComponent } from '#/tui/components/messages/step-summary';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('StepSummaryComponent', () => {
  it('renders nothing when empty', () => {
    const component = new StepSummaryComponent();
    expect(component.isEmpty).toBe(true);
    expect(component.render(80)).toEqual([]);
  });

  it('renders thinking and tool counts without a message part', () => {
    const component = new StepSummaryComponent();
    component.addCounts(5, 50);
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('thinking 5 times');
    expect(out).toContain('call 50 tools');
    expect(out).not.toContain('messages');
  });

  it('renders folded assistant message counts and accumulates', () => {
    const component = new StepSummaryComponent();
    component.addCounts(0, 0, 3);
    component.addCounts(2, 4, 5);
    const out = strip(component.render(80).join('\n'));
    expect(component.isEmpty).toBe(false);
    expect(out).toContain('thinking 2 times');
    expect(out).toContain('call 4 tools');
    expect(out).toContain('8 messages');
  });
});
