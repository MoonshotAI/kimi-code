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

  it('preserves password whitespace when trimming is disabled', () => {
    let submitted: string | undefined;
    const dialog = new ApiKeyInputDialogComponent(
      'dev-box',
      ['Password'],
      (result) => {
        if (result.kind === 'ok') submitted = result.value;
      },
      { trimValue: false },
    );
    dialog.handleInput(' secret ');
    dialog.handleInput('\r');
    expect(submitted).toBe(' secret ');
  });

  it('does not convert trailing layout padding into password bullets', () => {
    const dialog = new ApiKeyInputDialogComponent('dev-box', [], () => {});
    dialog.handleInput('smoke-password');
    const rendered = dialog.render(60).join('\n');
    expect(rendered).not.toContain('smoke-password');
    expect(rendered.match(/•/g)).toHaveLength(14);
  });
});
