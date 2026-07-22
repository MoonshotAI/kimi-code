import type { TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';

function stubTui(): TUI {
  return {
    terminal: { rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function createRead(id: string, filePath: string, ui: TUI): ToolCallComponent {
  return new ToolCallComponent(
    {
      id,
      name: 'Read',
      args: { file_path: filePath },
    },
    undefined,
    ui,
  );
}

describe('ReadGroupComponent', () => {
  it('requests one render when attaching a read', () => {
    const ui = stubTui();
    const group = new ReadGroupComponent(ui);
    const read = createRead('call_read_1', 'src/a.ts', ui);

    vi.mocked(ui.requestRender).mockClear();

    group.attach('call_read_1', read);

    expect(ui.requestRender).toHaveBeenCalledTimes(1);

    group.dispose();
    read.dispose();
  });
});
