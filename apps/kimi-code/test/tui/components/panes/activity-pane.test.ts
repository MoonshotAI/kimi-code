import { Text, visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';

function createMockSpinner(initialText = 'working') {
  const spinner = new Text(initialText, 0, 0);
  let tip = '';
  let availableWidth = 0;
  const update = () => {
    const fullText = initialText + tip;
    spinner.setText(availableWidth > 0 && visibleWidth(fullText) > availableWidth ? initialText : fullText);
  };
  return {
    spinner: Object.assign(spinner, {
      setTip(value: string) {
        tip = value;
        update();
      },
      setAvailableWidth(width: number) {
        availableWidth = width;
        update();
      },
    }) as unknown as import('#/tui/components/chrome/moon-loader').MoonLoader,
    getTip: () => tip,
  };
}

describe('ActivityPaneComponent', () => {
  it('renders waiting loader after a spacer', () => {
    const component = new ActivityPaneComponent({
      mode: 'waiting',
      spinner: new Text('loading', 0, 0) as never,
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'loading']);
  });

  it('renders composing spinner after a spacer', () => {
    const component = new ActivityPaneComponent({
      mode: 'composing',
      spinner: new Text('working', 0, 0) as never,
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'working']);
  });

  it.each(['waiting', 'tool', 'composing'] as const)(
    'renders %s spinner with tip after a spacer',
    (mode) => {
      const { spinner } = createMockSpinner('working');
      const component = new ActivityPaneComponent({
        mode,
        spinner,
        tip: 'ctrl+s: steer mid-turn',
      });

      expect(component.render(80).map((line) => line.trimEnd())).toEqual([
        '',
        'working · Tip: ctrl+s: steer mid-turn',
      ]);
    },
  );

  it.each(['waiting', 'tool', 'composing'] as const)(
    'does not render a tip for %s when none is provided',
    (mode) => {
      const { spinner } = createMockSpinner('working');
      const component = new ActivityPaneComponent({
        mode,
        spinner,
      });

      expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'working']);
    },
  );

  it('renders nothing for hidden and thinking modes', () => {
    expect(new ActivityPaneComponent({ mode: 'hidden' }).render(80)).toEqual([]);
    expect(new ActivityPaneComponent({ mode: 'thinking' }).render(80)).toEqual([]);
  });

  it.each(['waiting', 'tool', 'composing'] as const)(
    'hides the tip for %s when the terminal is too narrow',
    (mode) => {
      const { spinner } = createMockSpinner('working');
      const component = new ActivityPaneComponent({
        mode,
        spinner,
        tip: 'ctrl+s: steer mid-turn',
      });

      // Width 8 is exactly the width of "working" (no spinner frame in the mock).
      expect(component.render(8).map((line) => line.trimEnd())).toEqual(['', 'working']);
    },
  );
});
