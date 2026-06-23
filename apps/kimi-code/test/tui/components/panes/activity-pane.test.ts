import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';

function createMockSpinner(initialText = 'working') {
  const spinner = new Text(initialText, 0, 0);
  let tip = '';
  return {
    spinner: Object.assign(spinner, {
      setTip(value: string) {
        tip = value;
        spinner.setText(initialText + tip);
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

  it('renders composing spinner with tip after a spacer', () => {
    const { spinner } = createMockSpinner('working');
    const component = new ActivityPaneComponent({
      mode: 'composing',
      spinner,
      tip: 'ctrl+s: steer mid-turn',
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual([
      '',
      'working · Tips: ctrl+s: steer mid-turn',
    ]);
  });

  it('does not render a tip when none is provided', () => {
    const { spinner } = createMockSpinner('working');
    const component = new ActivityPaneComponent({
      mode: 'composing',
      spinner,
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'working']);
  });

  it('renders nothing for hidden and thinking modes', () => {
    expect(new ActivityPaneComponent({ mode: 'hidden' }).render(80)).toEqual([]);
    expect(new ActivityPaneComponent({ mode: 'thinking' }).render(80)).toEqual([]);
  });
});
