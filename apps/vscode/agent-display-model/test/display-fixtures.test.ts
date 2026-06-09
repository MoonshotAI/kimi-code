import { describe, expect, it } from 'vitest';

import { createInitialDisplayState, reduceDisplayEvent, type DisplayEffect, type DisplayState } from '../src';
import { displayReducerFixtures } from './fixtures/display-reducer-fixtures';

function reduceFixture(events: typeof displayReducerFixtures[number]['events']) {
  let state = createInitialDisplayState();
  const effects: DisplayEffect[] = [];

  for (const event of events) {
    const reduction = reduceDisplayEvent(state, event);
    state = reduction.state;
    effects.push(...reduction.effects);
  }

  return { effects, state };
}

describe('shared display reducer fixtures', () => {
  for (const fixture of displayReducerFixtures) {
    it(fixture.name, () => {
      const { effects, state } = reduceFixture(fixture.events);

      expect<DisplayState>(state).toMatchObject(fixture.expectedState);
      expect<DisplayEffect[]>(effects).toEqual(fixture.expectedEffects);
    });
  }
});
