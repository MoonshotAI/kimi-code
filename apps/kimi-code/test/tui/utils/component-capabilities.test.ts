import { describe, expect, it } from 'vitest';

import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import {
  isExpandable,
  isPlanExpandable,
  isThemeAware,
  hasDispose,
} from '#/tui/utils/component-capabilities';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';

describe('isThemeAware', () => {
  it('returns true for AssistantMessageComponent', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    expect(isThemeAware(component)).toBe(true);
  });

  it('returns false for plain objects', () => {
    expect(isThemeAware({})).toBe(false);
    expect(isThemeAware(null)).toBe(false);
    expect(isThemeAware(undefined)).toBe(false);
    expect(isThemeAware('string')).toBe(false);
    expect(isThemeAware(42)).toBe(false);
  });

  it('returns false for objects with non-function applyTheme', () => {
    expect(isThemeAware({ applyTheme: 'not-a-function' })).toBe(false);
  });

  it('returns true for objects implementing ThemeAwareComponent', () => {
    const fake = {
      applyTheme: () => {},
    };
    expect(isThemeAware(fake)).toBe(true);
  });
});

describe('isExpandable', () => {
  it('returns true for objects with setExpanded function', () => {
    expect(isExpandable({ setExpanded: () => {} })).toBe(true);
  });

  it('returns false for plain objects', () => {
    expect(isExpandable({})).toBe(false);
    expect(isExpandable(null)).toBe(false);
  });
});

describe('isPlanExpandable', () => {
  it('returns true for objects with setPlanExpanded function', () => {
    expect(isPlanExpandable({ setPlanExpanded: () => true })).toBe(true);
  });

  it('returns false for plain objects', () => {
    expect(isPlanExpandable({})).toBe(false);
    expect(isPlanExpandable(null)).toBe(false);
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
