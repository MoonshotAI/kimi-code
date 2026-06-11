import { describe, expect, it } from 'vitest';

import {
  isExpandable,
  hasDispose,
} from '#/tui/utils/component-capabilities';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';

describe('isExpandable', () => {
  it('returns true for objects with setExpanded function', () => {
    expect(isExpandable({ setExpanded: () => {} })).toBe(true);
  });

  it('returns false for plain objects', () => {
    expect(isExpandable({})).toBe(false);
    expect(isExpandable(null)).toBe(false);
    expect(isExpandable(undefined)).toBe(false);
    expect(isExpandable('string')).toBe(false);
    expect(isExpandable(42)).toBe(false);
  });

  it('returns false for objects with non-function setExpanded', () => {
    expect(isExpandable({ setExpanded: 'not-a-function' })).toBe(false);
  });
});

describe('hasDispose', () => {
  it('returns true for objects with dispose function', () => {
    expect(hasDispose({ dispose: () => {} })).toBe(true);
  });

  it('returns false for plain objects', () => {
    expect(hasDispose({})).toBe(false);
    expect(hasDispose(null)).toBe(false);
  });
});

describe('AssistantMessageComponent implements Expandable-adjacent patterns', () => {
  it('has setShowBullet method', () => {
    const component = new AssistantMessageComponent();
    expect(typeof component.setShowBullet).toBe('function');
  });
});
