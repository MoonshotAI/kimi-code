import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFollowScroll } from '../src/composables';

class FakeResizeObserver {
  static last: FakeResizeObserver | undefined;
  private readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.last = this;
  }
  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
  trigger(target?: Element): void {
    if (target !== undefined && !this.observed.has(target)) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

class FakeMutationObserver {
  constructor(_callback: MutationCallback) {}
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('MutationObserver', FakeMutationObserver);
});

afterEach(() => vi.unstubAllGlobals());

describe('useFollowScroll', () => {
  it('writes scrollTop from ResizeObserver growth and stops after the user scrolls up', async () => {
    const identity = ref<string | null>('agent-a');
    let follow:
      | ReturnType<typeof useFollowScroll>
      | undefined;
    const app = renderer.createApp(defineComponent(() => {
      follow = useFollowScroll(identity);
      return () => h('div');
    }));
    app.mount({ children: [] });

    const content = {} as Element;
    const metrics = {
      scrollHeight: 100,
      scrollTop: 0,
      clientHeight: 100,
      firstElementChild: content,
    };
    const element = metrics as unknown as HTMLElement;
    follow!.scroller.value = element;
    await nextTick();
    const observedContent = follow!.scroller.value!.firstElementChild!;
    expect(element.scrollTop).toBe(0);
    FakeResizeObserver.last!.trigger();
    expect(element.scrollTop).toBe(100);

    metrics.scrollHeight = 200;
    FakeResizeObserver.last!.trigger();
    expect(element.scrollTop).toBe(200);

    metrics.scrollTop = 0;
    follow!.onScroll();
    expect(follow!.following.value).toBe(false);
    metrics.scrollHeight = 300;
    FakeResizeObserver.last!.trigger();
    expect(element.scrollTop).toBe(0);

    identity.value = 'agent-b';
    await nextTick();
    expect(follow!.following.value).toBe(true);
    expect(element.scrollTop).toBe(0);
    FakeResizeObserver.last!.trigger();
    expect(element.scrollTop).toBe(300);

    metrics.scrollHeight = 400;
    FakeResizeObserver.last!.trigger(observedContent);
    expect(element.scrollTop).toBe(400);
    app.unmount();
  });

  it('uses observed dimensions while scrolling and settles disclosure follow state after layout', async () => {
    const identity = ref<string | null>('agent-a');
    let follow:
      | ReturnType<typeof useFollowScroll>
      | undefined;
    const app = renderer.createApp(defineComponent(() => {
      follow = useFollowScroll(identity);
      return () => h('div');
    }));
    app.mount({ children: [] });

    let scrollHeight = 200;
    let clientHeight = 100;
    let scrollTop = 100;
    const readScrollHeight = vi.fn(() => scrollHeight);
    const readClientHeight = vi.fn(() => clientHeight);
    const element = {
      firstElementChild: {} as Element,
      get scrollHeight() {
        return readScrollHeight();
      },
      get clientHeight() {
        return readClientHeight();
      },
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = Math.min(value, Math.max(0, scrollHeight - clientHeight));
      },
    } as HTMLElement;

    follow!.scroller.value = element;
    await nextTick();
    FakeResizeObserver.last!.trigger();
    readScrollHeight.mockClear();
    readClientHeight.mockClear();

    scrollTop = 60;
    follow!.onScroll();
    expect(follow!.following.value).toBe(false);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();

    scrollTop = 100;
    follow!.pinScroll();
    expect(follow!.following.value).toBe(false);
    scrollHeight = 300;
    FakeResizeObserver.last!.trigger();
    expect(follow!.following.value).toBe(false);

    follow!.pinScroll();
    scrollHeight = 200;
    FakeResizeObserver.last!.trigger();
    expect(follow!.following.value).toBe(true);
    app.unmount();
  });
});

interface HostNode {
  children: HostNode[];
  parent?: HostNode;
  text?: string;
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove: () => {},
  createElement: () => ({ children: [] }),
  createText: (text) => ({ children: [], text }),
  createComment: (text) => ({ children: [], text }),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling: () => null,
  querySelector: () => null,
  setScopeId: () => {},
  cloneNode: (node) => ({ ...node, children: [...node.children] }),
  insertStaticContent: () => {
    const node = { children: [] };
    return [node, node];
  },
});
