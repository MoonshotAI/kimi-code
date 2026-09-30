import { describe, expect, it } from 'vitest';

import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePanel(): BtwPanelComponent {
  return new BtwPanelComponent({
    markdownTheme: createMarkdownTheme(),
    canUseScrollKeys: () => false,
    onPrompt: () => {},
    terminalRows: () => 0,
  });
}

describe('BtwPanelComponent', () => {
  it('defers mermaid drawing until the turn completes', () => {
    const panel = makePanel();
    panel.submit('draw a flow');
    panel.appendAnswer('```mermaid\nflowchart LR\n  A-->B\n```\n');

    const streaming = strip(panel.render(60).join('\n'));
    expect(streaming).toContain('A-->B');
    expect(streaming).not.toContain('┌');

    panel.markDone();
    const done = strip(panel.render(60).join('\n'));
    expect(done).not.toContain('A-->B');
    expect(done).toContain('┌');
  });
});
