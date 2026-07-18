import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

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

  it('submits an empty value when the caller allows key reuse', () => {
    const onDone = vi.fn();
    const dialog = new ApiKeyInputDialogComponent(
      'LangSearch Rerank',
      ['Leave empty to reuse the search key.'],
      onDone,
      { allowEmpty: true },
    );

    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({ kind: 'ok', value: '' });
  });

  it('rejects an empty value by default', () => {
    const onDone = vi.fn();
    const dialog = new ApiKeyInputDialogComponent(
      'LangSearch',
      ['Paste your API key below.'],
      onDone,
    );

    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(dialog.render(80).join('\n')).toContain('API key cannot be empty.');
  });
});
