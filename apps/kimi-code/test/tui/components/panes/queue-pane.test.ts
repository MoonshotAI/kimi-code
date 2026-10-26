import { describe, expect, it } from 'vitest';

import { QueuePaneComponent, type QueuePaneOptions } from '#/tui/components/panes/queue-pane';

function inlinePane(options: QueuePaneOptions): QueuePaneComponent {
  const pane = new QueuePaneComponent();
  pane.setOptions(options);
  return pane;
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('QueuePaneComponent', () => {
  it('renders queued messages with the steer hint', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [
        { text: 'first message' },
        { text: '/skill:review src/app.ts' },
      ],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('❯ first message');
    expect(output).toContain('❯ /skill:review src/app.ts');
    expect(output).toContain('ctrl-s to steer immediately');
  });

  it('renders compaction hint when waiting for compaction', () => {
    const component = inlinePane({
      isCompacting: true,
      isStreaming: false,
      canSteerImmediately: true,
      messages: [{ text: 'after compact' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('will send after compaction');
  });

  it('omits the steer hint when immediate steering is disabled', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: false,
      messages: [{ text: 'after init' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('will send after current task');
    expect(output).not.toContain('ctrl-s to steer immediately');
  });

  it('truncates long messages to a single line', () => {
    const longText = 'a'.repeat(200);
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: longText }],
    });

    const lines = component.render(30);
    expect(lines).toHaveLength(3); // border + message + hint
    const messageLine = stripAnsi(lines[1] as string);
    expect(messageLine).not.toContain('a'.repeat(30));
    expect(messageLine.endsWith('…')).toBe(true);
  });

  it('collapses multiline text into a single line', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'line one\nline two\nline three' }],
    });

    const lines = component.render(120);
    expect(lines).toHaveLength(3); // border + message + hint
    const messageLine = stripAnsi(lines[1] as string);
    expect(messageLine).toContain('line one line two line three');
    expect(messageLine).not.toContain('\n');
  });

  it('renders bash queued items with a $ prompt to distinguish them from text', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: false,
      messages: [{ text: 'ls -la', mode: 'bash' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).toContain('❯ $ ls -la');
  });

  it('omits the steer hint when every queued item is a bash command', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'ls', mode: 'bash' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).not.toContain('ctrl-s to steer immediately');
    expect(output).toContain('will send after current task');
  });

  it('keeps the steer hint when at least one queued item is steerable', () => {
    const component = inlinePane({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'ls', mode: 'bash' }, { text: 'focus on tests' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).toContain('ctrl-s to steer immediately');
  });

  it('names the total in the hint only when a docked list has more rows than it shows', () => {
    const options = (count: number): QueuePaneOptions => ({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: Array.from({ length: count }, (_, i) => ({ text: `item ${String(i + 1)}` })),
    });
    const docked = new QueuePaneComponent({ maxBodyRows: 3 });
    const hint = (pane: QueuePaneComponent): string =>
      stripAnsi(pane.render(120).at(-1) ?? '').trim();

    docked.setOptions(options(3));
    expect(hint(docked)).toBe('↑ to edit · ctrl-s to steer immediately');
    docked.setOptions(options(5));
    expect(hint(docked)).toBe('5 queued · ↑ to edit · ctrl-s to steer immediately');
    expect(hint(inlinePane(options(5)))).toBe('↑ to edit · ctrl-s to steer immediately');
  });
});
