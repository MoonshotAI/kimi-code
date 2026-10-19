import { describe, expect, it } from 'vitest';

import { SurveyPreferenceSelectorComponent } from '#/tui/components/dialogs/survey-preference-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('SurveyPreferenceSelectorComponent', () => {
  it('maps the current preference onto the picker options', () => {
    const selected: boolean[] = [];
    const enabledPicker = new SurveyPreferenceSelectorComponent({
      currentValue: true,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });
    const disabledPicker = new SurveyPreferenceSelectorComponent({
      currentValue: false,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });

    expect(strip(enabledPicker.render(60).join('\n'))).toContain('Feedback survey');
    expect(strip(disabledPicker.render(60).join('\n'))).toContain('Off');

    enabledPicker.handleInput('\r');
    expect(selected).toEqual([true]);
    disabledPicker.handleInput('\r');
    expect(selected).toEqual([true, false]);
  });
});
