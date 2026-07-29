import { afterEach, describe, expect, it, vi } from 'vitest';

import { track } from '../../src/renderer/lib/track';

// Renderer tests run in the node environment, so there is no real `window`;
// each test installs just enough of it to stand in for the preload bridge.
const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
});

describe('track', () => {
  it('is a silent no-op with no preload bridge (web snapshot / tests)', () => {
    delete globalRef.window;
    expect(() => track('action_invoked', { action: 'newSession', source: 'shortcut' })).not.toThrow();
  });

  it('is a silent no-op when the bridge predates the track method', () => {
    globalRef.window = { kimiDesktop: {} };
    expect(() => track('update_prompt_shown', {})).not.toThrow();
  });

  it('forwards the event and properties to the bridge verbatim', () => {
    const spy = vi.fn();
    globalRef.window = { kimiDesktop: { track: spy } };
    track('update_prompt_action', { action: 'skip', version: '1.2.3' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('update_prompt_action', { action: 'skip', version: '1.2.3' });
  });

  it('forwards an empty properties bag verbatim', () => {
    const spy = vi.fn();
    globalRef.window = { kimiDesktop: { track: spy } };
    track('update_prompt_shown', {});
    expect(spy).toHaveBeenCalledWith('update_prompt_shown', {});
  });

  it('swallows bridge errors instead of letting them break the UI', () => {
    globalRef.window = {
      kimiDesktop: {
        track: () => {
          throw new Error('ipc gone');
        },
      },
    };
    expect(() => track('action_invoked', { action: 'openSettings', source: 'menu' })).not.toThrow();
  });
});
