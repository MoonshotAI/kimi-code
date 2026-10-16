import { describe, expect, it, vi } from 'vitest';

import { SessionOccupiedDialogComponent } from '#/tui/components/dialogs/session-occupied-dialog';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderDialog(
  message = 'This session is in use by another Kimi Code process. Stop the session in that process or exit it, then try again.',
) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new SessionOccupiedDialogComponent({ message, onSelect, onCancel });
  return { dialog, onSelect, onCancel, lines: dialog.render(120).map(strip) };
}

describe('SessionOccupiedDialogComponent', () => {
  it('renders the occupancy message in the title and the standard hint vocabulary', () => {
    const { lines } = renderDialog();
    const titleIdx = lines.findIndex((l) => l.includes('in use by another Kimi Code process'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(lines[titleIdx + 1]).toContain('↑↓ navigate');
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
  });

  it('renders both options in order', () => {
    const { lines } = renderDialog();
    const retry = lines.findIndex((l) => l.includes('Retry'));
    const cancel = lines.findIndex((l) => l.includes('Cancel'));
    expect(retry).toBeGreaterThanOrEqual(0);
    expect(retry).toBeLessThan(cancel);
    expect(lines[retry]).toContain('send again now');
    expect(lines[cancel]).toContain('get your message back');
  });

  it('selects Retry by default on Enter', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('retry');
  });

  it('navigates to Cancel with the down arrow', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('cancel');
  });

  it('cancels on Esc without selecting', () => {
    const { dialog, onSelect, onCancel } = renderDialog();
    dialog.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
