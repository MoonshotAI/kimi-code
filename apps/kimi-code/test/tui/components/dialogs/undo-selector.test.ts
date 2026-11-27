import { ScrollView, Text, TuiAltScreen, VStack } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UndoSelectorComponent,
  type UndoChoice,
} from '#/tui/components/dialogs/undo-selector';

const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

function makeChoices(count: number): readonly UndoChoice[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${String(i + 1)}`,
    count: count - i,
    input: `prompt ${String(i + 1)}`,
    label: `Message ${String(i + 1)}`,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UndoSelectorComponent', () => {
  it('renders a bounded 5-row window in regular mode starting at the newest message', () => {
    const selector = new UndoSelectorComponent({
      choices: makeChoices(8),
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = selector.render(80).map(strip).join('\n');
    expect(out).toContain('Message 8');
    expect(out).toContain('Message 4');
    expect(out).not.toContain('Message 3');
  });

  it('supports fullscreen wheel scrolling across header and body without transcript leak, previews hovered turn on move, and commits clicked turn once', async () => {
    let now = 30_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onSelect = vi.fn();
    const choices = makeChoices(8);
    const selector = new UndoSelectorComponent({
      choices,
      layout: { maxBodyRows: 4, follow: 'end' },
      onSelect,
      onCancel: vi.fn(),
    });
    const transcript = new ScrollView(
      new Text(Array.from({ length: 15 }, (_, i) => `history-${String(i + 1)}`).join('\n'), 0, 0),
      { follow: 'end', primary: true },
    );
    const vt = new VirtualTerminal(80, 16);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: selector, shrink: 1, minSize: 3 },
      ]),
    );
    ui.start();
    ui.setFocus(selector);
    await vt.waitForRender();
    try {
      let screen = vt.getViewport().map(strip);
      expect(screen.join('\n')).toContain('❯ Message 8');
      const initialTranscriptTop = transcript.scrollTop;

      const headerRow = screen.findIndex((line) => line.includes('Select messages to undo'));
      expect(headerRow).toBeGreaterThan(0);
      for (let i = 0; i < 15; i++) {
        vt.sendInput(`\u001B[<64;10;${String(headerRow + 1)}M`);
      }
      await vt.waitForRender();
      expect(transcript.scrollTop).toBe(initialTranscriptTop);

      screen = vt.getViewport().map(strip);
      const msg2Row = screen.findIndex((line) => line.includes('Message 2'));
      expect(msg2Row).toBeGreaterThan(0);

      vt.sendInput(`\u001B[<35;10;${String(msg2Row + 1)}M`);
      await vt.waitForRender();
      expect(vt.getViewport().map(strip)[msg2Row]).toContain('❯ Message 2');
      expect(onSelect).not.toHaveBeenCalled();

      now += 500;
      vt.sendInput(`\u001B[<0;10;${String(msg2Row + 1)}M`);
      vt.sendInput(`\u001B[<0;10;${String(msg2Row + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(choices[1]);
    } finally {
      ui.stop();
    }
  });
});
