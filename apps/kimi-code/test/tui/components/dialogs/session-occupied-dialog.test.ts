import { describe, expect, it, vi } from 'vitest';

import { SessionOccupiedDialogComponent } from '#/tui/components/dialogs/session-occupied-dialog';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderDialog(client = 'Web') {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new SessionOccupiedDialogComponent({ client, onSelect, onCancel });
  return { dialog, onSelect, onCancel, lines: dialog.render(120).map(strip) };
}

describe('SessionOccupiedDialogComponent', () => {
  it('renders the holder name in the title and the standard hint vocabulary', () => {
    const { lines } = renderDialog('Web');
    const titleIdx = lines.findIndex((l) => l.includes('Session in use by Web'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(lines[titleIdx + 1]).toContain('↑↓ navigate');
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
  });

  it('renders the body line and both options in order', () => {
    const { lines } = renderDialog();
    expect(lines.some((l) => l.includes('Another client is running this session'))).toBe(true);
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
