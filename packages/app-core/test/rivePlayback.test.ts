import { describe, expect, it, vi } from 'vitest';

import { bindRivePlayback, type RivePlaybackSinks } from '../src/lib/rivePlayback';

interface FakeEnv {
  sinks: RivePlaybackSinks;
  setHidden: (hidden: boolean) => void;
  setInView: (inView: boolean) => void;
  unsubscribed: () => number;
}

function fakeEnv(initial: { hidden?: boolean; inView?: boolean } = {}): FakeEnv {
  let hidden = initial.hidden ?? false;
  let unsubscribes = 0;
  let visibilityCallback: (() => void) | null = null;
  let intersectionCallback: ((inView: boolean) => void) | null = null;
  const initialInView = initial.inView;
  const sinks: RivePlaybackSinks = {
    isPageHidden: () => hidden,
    onVisibilityChange: (callback) => {
      visibilityCallback = callback;
      return () => {
        visibilityCallback = null;
        unsubscribes += 1;
      };
    },
    observeIntersection: (_element, callback) => {
      intersectionCallback = callback;
      // Real IntersectionObservers fire once with the current state on observe.
      if (initialInView !== undefined) callback(initialInView);
      return () => {
        intersectionCallback = null;
        unsubscribes += 1;
      };
    },
  };
  return {
    sinks,
    setHidden: (value) => {
      hidden = value;
      visibilityCallback?.();
    },
    setInView: (value) => intersectionCallback?.(value),
    unsubscribed: () => unsubscribes,
  };
}

function fakeRive() {
  return { play: vi.fn(), pause: vi.fn() };
}

const element = {} as Element;

describe('bindRivePlayback', () => {
  it('does nothing while the page is visible and the element is in view', () => {
    const env = fakeEnv({ inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    expect(rive.pause).not.toHaveBeenCalled();
    expect(rive.play).not.toHaveBeenCalled();
  });

  it('pauses immediately when bound on a hidden page', () => {
    const env = fakeEnv({ hidden: true, inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    expect(rive.pause).toHaveBeenCalledOnce();
    expect(rive.play).not.toHaveBeenCalled();
  });

  it('pauses when the page hides and resumes when it becomes visible again', () => {
    const env = fakeEnv({ inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    env.setHidden(true);
    expect(rive.pause).toHaveBeenCalledOnce();
    env.setHidden(false);
    expect(rive.play).toHaveBeenCalledOnce();
  });

  it('pauses when the element leaves the viewport and resumes on re-entry', () => {
    const env = fakeEnv({ inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    env.setInView(false);
    expect(rive.pause).toHaveBeenCalledOnce();
    env.setInView(true);
    expect(rive.play).toHaveBeenCalledOnce();
  });

  it('stays paused until both the page and the viewport allow playback', () => {
    const env = fakeEnv({ inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    env.setHidden(true);
    env.setInView(false);
    expect(rive.pause).toHaveBeenCalledOnce();
    // One gate reopens while the other stays closed: still paused.
    env.setHidden(false);
    expect(rive.play).not.toHaveBeenCalled();
    env.setInView(true);
    expect(rive.play).toHaveBeenCalledOnce();
  });

  it('does not repeat pause/play when state flips without an effective change', () => {
    const env = fakeEnv({ hidden: true, inView: true });
    const rive = fakeRive();
    bindRivePlayback(rive, element, env.sinks);
    expect(rive.pause).toHaveBeenCalledOnce();
    // Still hidden — a viewport wobble must not resume or re-pause.
    env.setInView(false);
    env.setInView(true);
    expect(rive.pause).toHaveBeenCalledOnce();
    expect(rive.play).not.toHaveBeenCalled();
  });

  it('treats the element as in view when no intersection observer is provided', () => {
    const env = fakeEnv();
    const rive = fakeRive();
    bindRivePlayback(rive, element, {
      ...env.sinks,
      observeIntersection: () => () => {},
    });
    env.setHidden(true);
    expect(rive.pause).toHaveBeenCalledOnce();
  });

  it('stops reacting and unsubscribes after teardown', () => {
    const env = fakeEnv({ inView: true });
    const rive = fakeRive();
    const teardown = bindRivePlayback(rive, element, env.sinks);
    teardown();
    expect(env.unsubscribed()).toBe(2);
    env.setHidden(true);
    env.setInView(false);
    expect(rive.pause).not.toHaveBeenCalled();
    expect(rive.play).not.toHaveBeenCalled();
  });
});
