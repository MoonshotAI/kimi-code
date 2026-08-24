import { describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StepSummaryComponent } from '#/tui/components/messages/step-summary';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function assistant(text: string): AssistantMessageComponent {
  const component = new AssistantMessageComponent();
  component.updateContent(text);
  return component;
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

  it('reveals folded assistant message snapshots in order when expanded', () => {
    const component = new StepSummaryComponent();
    const first = assistant('first hidden reply');
    component.addCounts(0, 0, 2);
    component.addFoldedMessages([first, assistant('second hidden reply')]);
    first.updateContent('mutated after folding');

    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).toContain('2 messages');
    expect(collapsed).not.toContain('first hidden reply');

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('first hidden reply');
    expect(expanded).toContain('second hidden reply');
    expect(expanded).not.toContain('mutated after folding');
    expect(expanded.indexOf('first hidden reply')).toBeLessThan(
      expanded.indexOf('second hidden reply'),
    );

    component.setExpanded(false);
    expect(strip(component.render(80).join('\n'))).not.toContain('first hidden reply');
  });

  it('renders a large set of folded snapshots', () => {
    const component = new StepSummaryComponent();
    const messages = Array.from({ length: 100 }, (_, index) => assistant(`hidden reply ${index}`));
    component.addCounts(0, 0, messages.length);
    component.addFoldedMessages(messages);
    component.setExpanded(true);

    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('hidden reply 0');
    expect(expanded).toContain('hidden reply 99');
  });
});
