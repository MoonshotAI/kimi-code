import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('masks the secret with bullets and never renders the raw password', () => {
    const password = 's3cret-p@ssw0rd';
    const dialog = new ApiKeyInputDialogComponent(
      'sudo',
      ['[sudo] password for alice:', '$ sudo ls /root'],
      () => {},
      { title: 'sudo password required' },
    );
    dialog.focused = true;
    for (const ch of password) {
      dialog.handleInput(ch);
    }

    for (const width of [80, 39, 20]) {
      const lines = dialog.render(width);
      for (const line of lines) {
        expect(line).not.toContain(password);
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    // At full width every typed character renders as a bullet (the cursor
    // cell is masked too, and escape sequences may interrupt the run, so
    // count bullets instead of matching a contiguous string).
    const fullWidth = dialog.render(80).join('\n');
    const bulletCount = (fullWidth.match(/•/g) ?? []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(password.length);
  });
});
