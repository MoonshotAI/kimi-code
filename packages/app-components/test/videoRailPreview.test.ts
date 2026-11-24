import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import { useVideoRailPreview } from '../src/chat/useVideoRailPreview';

const media = vi.hoisted(() => ({
  getFileBlob: vi.fn(),
  getSessionMediaBlob: vi.fn(),
  createVideoThumbnail: vi.fn(),
}));
vi.mock('@moonshot-ai/app-client/client', () => ({ getKimiWebApi: () => media }));
vi.mock('@moonshot-ai/app-client/lib', () => ({ createVideoThumbnail: media.createVideoThumbnail }));
const Preview = defineComponent({
  props: { fileId: { type: String, required: true }, sessionId: String },
  setup(props) {
    const host = ref<HTMLElement | null>(null);
    const thumbnail = useVideoRailPreview(host, props);
    return () => h('span', { ref: host }, thumbnail.value ? [h('img', { src: thumbnail.value })] : []);
  },
});

interface TestNode {
  tag: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}
function node(tag: string): TestNode {
  return { tag, props: {}, children: [], parent: null };
}
const renderer = createRenderer<TestNode, TestNode>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  parentNode: (el) => el.parent,
  nextSibling: (el) => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  insert(el, parent, anchor) {
    el.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(el);
    else parent.children.splice(index, 0, el);
  },
  remove(el) {
    const siblings = el.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(el), 1);
    el.parent = null;
  },
  patchProp(el, key, _, value) { el.props[key] = value; },
});
function descendants(root: TestNode): TestNode[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}
const roots: TestNode[] = [];
function mount(props: Record<string, unknown> = {}) {
  const root = node('root');
  roots.push(root);
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const render = (changes: Record<string, unknown> = {}) => renderer.render(h(Preview, {
    fileId: 'video', ...props, ...changes,
  }), root);
  render();
  return { root, render, disconnect, enter: () => intersect([{ isIntersecting: true }]) };
}

afterEach(() => {
  for (const root of roots.splice(0)) renderer.render(null, root);
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('remote video rail previews', () => {
  it.each([undefined, 'session'])('loads a bounded prefix only near the viewport (%s)', async (sessionId) => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    media.getFileBlob.mockResolvedValue(blob);
    media.getSessionMediaBlob.mockResolvedValue(blob);
    media.createVideoThumbnail.mockResolvedValue('data:image/jpeg;base64,frame');
    const mounted = mount({ sessionId });
    await nextTick();
    expect(media.getFileBlob).not.toHaveBeenCalled();
    expect(media.getSessionMediaBlob).not.toHaveBeenCalled();
    expect(descendants(mounted.root).some((el) => el.tag === 'video')).toBe(false);

    mounted.enter();
    await vi.waitFor(() => {
      expect(descendants(mounted.root).find((el) => el.tag === 'img')?.props.src)
        .toBe('data:image/jpeg;base64,frame');
    });
    const options = expect.objectContaining({ prefixBytes: 2 * 1024 * 1024, signal: expect.any(AbortSignal) });
    if (sessionId) expect(media.getSessionMediaBlob).toHaveBeenCalledWith(sessionId, 'video', options);
    else expect(media.getFileBlob).toHaveBeenCalledWith('video', options);
    expect(media.createVideoThumbnail).toHaveBeenCalledWith(blob, expect.any(AbortSignal));
    expect(mounted.disconnect).toHaveBeenCalled();
  });

  it('keeps the placeholder on decode failure without retrying a full download', async () => {
    media.getFileBlob.mockResolvedValue(new Blob(['incomplete video']));
    media.createVideoThumbnail.mockResolvedValue(undefined);
    const mounted = mount();
    mounted.enter();
    await vi.waitFor(() => expect(media.createVideoThumbnail).toHaveBeenCalledOnce());
    expect(descendants(mounted.root).some((el) => el.tag === 'img' || el.tag === 'video')).toBe(false);
    expect(media.getFileBlob).toHaveBeenCalledOnce();
  });

  it('cancels pending reads on unmount and does not decode their late results', async () => {
    let finish!: (blob: Blob) => void;
    media.getFileBlob.mockReturnValue(new Promise<Blob>((resolve) => { finish = resolve; }));
    const mounted = mount();
    mounted.enter();
    await nextTick();
    const signal = media.getFileBlob.mock.calls[0]![1].signal as AbortSignal;
    renderer.render(null, mounted.root);
    expect(signal.aborted).toBe(true);
    finish(new Blob(['late']));
    await nextTick();
    expect(media.createVideoThumbnail).not.toHaveBeenCalled();
  });

  it('does not replace a newer preview with stale decoding output', async () => {
    media.getFileBlob.mockResolvedValue(new Blob(['video']));
    let finish!: (result: string) => void;
    media.createVideoThumbnail.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }))
      .mockResolvedValue('data:image/jpeg;base64,new');
    const mounted = mount();
    mounted.enter();
    await vi.waitFor(() => expect(media.createVideoThumbnail).toHaveBeenCalledOnce());
    const signal = media.createVideoThumbnail.mock.calls[0]![1] as AbortSignal;
    mounted.render({ fileId: 'new-video' });
    await vi.waitFor(() => {
      expect(descendants(mounted.root).find((el) => el.tag === 'img')?.props.src).toBe('data:image/jpeg;base64,new');
    });
    expect(signal.aborted).toBe(true);
    finish('data:image/jpeg;base64,old');
    await nextTick();
    expect(descendants(mounted.root).find((el) => el.tag === 'img')?.props.src).toBe('data:image/jpeg;base64,new');
  });

});
