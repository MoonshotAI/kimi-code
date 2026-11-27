// @vitest-environment jsdom
import { createApp, defineComponent, effectScope, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { TABLE_WIDE_CLASS } from '@moonshot-ai/app-markdown/lib/tableWide';
import ConversationToc, { type ConversationTocItem } from '../src/chat/ConversationToc.vue';
import { isWideTableLayoutActive, useWideTableToc } from '../src/chat/useWideTableToc';

const TRANSITION_MS = 160;

function pane(expanded: number, plain = 0): HTMLElement {
  const root = document.createElement('div');
  for (let index = 0; index < expanded; index += 1) {
    const wrapper = document.createElement('div');
    wrapper.className = `table-node-wrapper ${TABLE_WIDE_CLASS}`;
    root.append(wrapper);
  }
  for (let index = 0; index < plain; index += 1) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-node-wrapper';
    root.append(wrapper);
  }
  return root;
}

describe('isWideTableLayoutActive', () => {
  it.each([
    { expanded: true, width: 760, expected: true },
    { expanded: true, width: 759, expected: false },
    { expanded: false, width: 1024, expected: false },
  ])('returns $expected when expanded is $expanded and the container is $width', ({ expanded, width, expected }) => {
    expect(isWideTableLayoutActive(expanded, width)).toBe(expected);
  });
});

describe('useWideTableToc', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the contents strip as soon as a table is expanded', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    expect(tocHidden.value).toBe(false);

    syncWideTable(pane(1));
    expect(tocHidden.value).toBe(true);
  });

  it('brings it back only once the collapsed table has finished narrowing', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    syncWideTable(pane(1));

    syncWideTable(pane(0, 1));
    expect(tocHidden.value).toBe(true);
    vi.advanceTimersByTime(TRANSITION_MS - 1);
    expect(tocHidden.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tocHidden.value).toBe(false);
  });

  it('keeps it hidden while any one of several tables is still expanded', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    syncWideTable(pane(2));

    syncWideTable(pane(1, 1));
    vi.advanceTimersByTime(TRANSITION_MS * 2);
    expect(tocHidden.value).toBe(true);

    syncWideTable(pane(0, 2));
    vi.advanceTimersByTime(TRANSITION_MS);
    expect(tocHidden.value).toBe(false);
  });

  it('abandons a pending restore when a table is expanded again', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    syncWideTable(pane(1));
    syncWideTable(pane(0, 1));

    vi.advanceTimersByTime(TRANSITION_MS - 20);
    syncWideTable(pane(1));
    vi.advanceTimersByTime(TRANSITION_MS * 2);
    expect(tocHidden.value).toBe(true);
  });

  it('does not restart the wait on unrelated updates while collapsing', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    syncWideTable(pane(1));
    syncWideTable(pane(0, 1));

    vi.advanceTimersByTime(TRANSITION_MS - 20);
    syncWideTable(pane(0, 1));
    vi.advanceTimersByTime(20);
    expect(tocHidden.value).toBe(false);
  });

  it('stays quiet when nothing was ever expanded', () => {
    const { tocHidden, syncWideTable } = useWideTableToc();
    syncWideTable(pane(0, 3));
    syncWideTable(null);
    vi.advanceTimersByTime(TRANSITION_MS);
    expect(tocHidden.value).toBe(false);
  });

  it('drops a pending restore when the pane goes away', () => {
    const scope = effectScope();
    const state = scope.run(() => useWideTableToc())!;
    state.syncWideTable(pane(1));
    state.syncWideTable(pane(0, 1));
    scope.stop();

    vi.advanceTimersByTime(TRANSITION_MS * 2);
    expect(state.tocHidden.value).toBe(true);
  });
});

describe('ConversationToc while a table is expanded', () => {
  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  let app: App | null = null;
  let container: HTMLElement;
  const tableExpanded = ref(false);

  function turn(no: number): ConversationTocItem {
    return { id: `t${no}`, role: 'user', no, title: `Turn ${no}` };
  }

  function nav(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.conversation-toc');
  }

  beforeEach(async () => {
    tableExpanded.value = false;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    container = document.createElement('div');
    document.body.append(container);
    app = createApp(defineComponent({
      setup() {
        return () => h(ConversationToc, {
          items: [turn(1), turn(2), turn(3)],
          activeTurnId: null,
          tableExpanded: tableExpanded.value,
        });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(container);
    await nextTick();
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  it('steps aside without animating, the same way it does when it lacks room', async () => {
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(nav()!.getAttribute('aria-hidden')).toBeNull();

    tableExpanded.value = true;
    await nextTick();
    expect(nav()!.classList.contains('toc-clipped')).toBe(true);
    expect(nav()!.getAttribute('aria-hidden')).toBe('true');

    tableExpanded.value = false;
    await nextTick();
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
  });
});
