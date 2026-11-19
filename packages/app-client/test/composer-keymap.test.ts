import { afterEach, describe, expect, it } from 'vitest';
import { resolveComposerBinding, setComposerKeymapResolver } from '../src/contracts';

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

afterEach(() => {
  setComposerKeymapResolver(null);
});

describe('default composer keymap', () => {
  it('shift+enter inserts a newline', () => {
    const binding = resolveComposerBinding('newline', { expanded: false });
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true }))).toBe(true);
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true, metaKey: true }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true, altKey: true }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'Enter' }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'a', shiftKey: true }))).toBe(false);
  });

  it('enter sends when the composer is collapsed', () => {
    const binding = resolveComposerBinding('send', { expanded: false });
    expect(binding?.matches(keyEvent({ key: 'Enter' }))).toBe(true);
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true }))).toBe(false);
  });

  it('enter does not send when expanded, mod/ctrl+enter still does', () => {
    const binding = resolveComposerBinding('send', { expanded: true });
    expect(binding?.matches(keyEvent({ key: 'Enter' }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'Enter', metaKey: true }))).toBe(true);
    expect(binding?.matches(keyEvent({ key: 'Enter', ctrlKey: true }))).toBe(true);
    expect(binding?.matches(keyEvent({ key: 'Enter', altKey: true }))).toBe(false);
    expect(binding?.matches(keyEvent({ key: 'Enter', shiftKey: true, metaKey: true }))).toBe(false);
  });

  it('never swallows shift+enter', () => {
    expect(resolveComposerBinding('swallow', { expanded: false })).toBeNull();
    expect(resolveComposerBinding('swallow', { expanded: true })).toBeNull();
  });
});

describe('setComposerKeymapResolver', () => {
  it('overrides the default resolver and resets on null', () => {
    setComposerKeymapResolver(() => null);
    expect(resolveComposerBinding('newline', { expanded: false })).toBeNull();
    expect(resolveComposerBinding('send', { expanded: false })).toBeNull();
    setComposerKeymapResolver(null);
    expect(resolveComposerBinding('newline', { expanded: false })).not.toBeNull();
    expect(resolveComposerBinding('send', { expanded: false })).not.toBeNull();
  });
});
