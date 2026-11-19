import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import {
  useComposerAutoFocus,
  type ComposerFocusHandle,
} from '@moonshot-ai/app-client/composables';

let activeElement: Element | null = null;

function fakeElement(tagName: string): Element {
  return { tagName, isContentEditable: false } as unknown as Element;
}

interface FakeComposer {
  el: Element;
  handle: ComposerFocusHandle & { focus: ReturnType<typeof vi.fn> };
  setDisabled: (disabled: boolean) => void;
}

function makeComposer(): FakeComposer {
  const el = fakeElement('TEXTAREA');
  let disabled = false;
  const handle = {
    focus: vi.fn(() => {
      if (!disabled) activeElement = el;
    }),
  };
  return {
    el,
    handle,
    setDisabled: (d) => {
      disabled = d;
    },
  };
}

interface Harness {
  sessionId: ReturnType<typeof ref<string | undefined>>;
  mobile: ReturnType<typeof ref<boolean>>;
  starting: ReturnType<typeof ref<boolean>>;
  docked: ReturnType<typeof ref<ComposerFocusHandle | null>>;
  empty: ReturnType<typeof ref<ComposerFocusHandle | null>>;
}

function setup(): Harness {
  const sessionId = ref<string | undefined>('s1');
  const mobile = ref(false);
  const starting = ref(false);
  const docked = ref<ComposerFocusHandle | null>(null);
  const empty = ref<ComposerFocusHandle | null>(null);
  useComposerAutoFocus({
    sessionId: () => sessionId.value,
    mobile: () => mobile.value,
    starting: () => starting.value,
    dockedComposer: docked,
    emptyComposer: empty,
  });
  return { sessionId, mobile, starting, docked, empty };
}

beforeEach(() => {
  activeElement = null;
  vi.stubGlobal('document', {
    get activeElement() {
      return activeElement;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useComposerAutoFocus', () => {
  it('focuses the docked composer when the session changes', async () => {
    const h = setup();
    const docked = makeComposer();
    h.docked.value = docked.handle;

    h.sessionId.value = 's2';
    await nextTick();
    expect(docked.handle.focus).toHaveBeenCalledTimes(1);
    expect(activeElement).toBe(docked.el);

    docked.handle.focus.mockClear();
    h.docked.value = { ...docked.handle };
    await nextTick();
    expect(docked.handle.focus).not.toHaveBeenCalled();
  });

  it('focuses the empty composer when it is the one mounted (empty session)', async () => {
    const h = setup();
    const empty = makeComposer();
    h.empty.value = empty.handle;

    h.sessionId.value = 's2';
    await nextTick();
    expect(empty.handle.focus).toHaveBeenCalledTimes(1);
    expect(activeElement).toBe(empty.el);
  });

  it('stays pending across the first-send transition until focus can land', async () => {
    const h = setup();
    const empty = makeComposer();
    empty.setDisabled(true);
    h.empty.value = empty.handle;
    h.starting.value = true;

    h.sessionId.value = 's2';
    await nextTick();
    expect(activeElement).toBeNull();

    const docked = makeComposer();
    docked.setDisabled(true);
    h.docked.value = docked.handle;
    await nextTick();
    expect(docked.handle.focus).toHaveBeenCalled();
    expect(activeElement).toBeNull();

    docked.setDisabled(false);
    h.starting.value = false;
    await nextTick();
    expect(activeElement).toBe(docked.el);
  });

  it('does not steal focus from another text-entry element', async () => {
    const h = setup();
    const docked = makeComposer();
    h.docked.value = docked.handle;
    activeElement = fakeElement('INPUT');

    h.sessionId.value = 's2';
    await nextTick();
    expect(docked.handle.focus).not.toHaveBeenCalled();
    expect(activeElement?.tagName).toBe('INPUT');

    h.docked.value = { ...docked.handle };
    await nextTick();
    expect(docked.handle.focus).not.toHaveBeenCalled();
  });

  it('never auto-focuses on mobile', async () => {
    const h = setup();
    h.mobile.value = true;
    const docked = makeComposer();
    h.docked.value = docked.handle;

    h.sessionId.value = 's2';
    await nextTick();
    expect(docked.handle.focus).not.toHaveBeenCalled();
  });
});
