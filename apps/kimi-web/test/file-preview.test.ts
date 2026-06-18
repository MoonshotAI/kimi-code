// apps/kimi-web/test/file-preview.test.ts
//
// File preview scroll behaviour: opening a file at a specific line should land
// on that line without an unexpected upward jump when the component is reused
// (e.g. switching from one file preview to another in the split-pane preview).

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import FilePreview, { type FileData } from '../src/components/FilePreview.vue';
import enFilePreview from '../src/i18n/locales/en/filePreview';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { filePreview: enFilePreview } },
  missingWarn: false,
  fallbackWarn: false,
});

function makeFile(path: string, content: string, lineCount: number): FileData {
  return {
    path,
    content,
    encoding: 'utf-8',
    mime: 'text/plain',
    isBinary: false,
    size: content.length,
    lineCount,
  };
}

function mockScrollGeometry(
  bodyEl: HTMLElement,
  lineEl: HTMLElement,
  options: {
    bodyClientHeight: number;
    lineOffsetTop: number;
    lineHeight: number;
    currentScrollTop?: number;
  },
): void {
  const { bodyClientHeight, lineOffsetTop, lineHeight, currentScrollTop = 0 } = options;
  Object.defineProperty(bodyEl, 'clientHeight', {
    configurable: true,
    get: () => bodyClientHeight,
  });
  Object.defineProperty(bodyEl, 'scrollTop', {
    configurable: true,
    writable: true,
    value: currentScrollTop,
  });
  Object.defineProperty(lineEl, 'offsetTop', {
    configurable: true,
    get: () => lineOffsetTop,
  });
  vi.spyOn(bodyEl, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 0,
    bottom: bodyClientHeight,
    width: 0,
    height: bodyClientHeight,
    x: 0,
    y: 0,
    toJSON: () => '',
  });
  vi.spyOn(lineEl, 'getBoundingClientRect').mockReturnValue({
    top: lineOffsetTop - currentScrollTop,
    left: 0,
    right: 0,
    bottom: lineOffsetTop - currentScrollTop + lineHeight,
    width: 0,
    height: lineHeight,
    x: 0,
    y: lineOffsetTop - currentScrollTop,
    toJSON: () => '',
  });
}

describe('FilePreview scroll-to-line', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('centers the requested line when first opening a file', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const wrapper = mount(FilePreview, {
      props: { file: makeFile('a.txt', content, 20), loading: false, line: 5 },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();

    const bodyEl = wrapper.find('.fp-body').element as HTMLElement;
    const lineEl = bodyEl.querySelector('[data-line="5"]') as HTMLElement;
    expect(lineEl).not.toBeNull();

    mockScrollGeometry(bodyEl, lineEl, { bodyClientHeight: 100, lineOffsetTop: 80, lineHeight: 20 });

    // Trigger the watcher again now that mocked geometry is in place.
    await wrapper.setProps({ file: makeFile('a.txt', content, 20), line: 5 });
    await nextTick();

    // Centered: line top (80) - body/2 (50) + line/2 (10) = 40
    expect(bodyEl.scrollTop).toBe(40);
  });

  it('resets scroll when switching to a different file so the new target line does not jump up from a stale position', async () => {
    const contentA = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const contentB = Array.from({ length: 20 }, (_, i) => `other ${i + 1}`).join('\n');

    const wrapper = mount(FilePreview, {
      props: { file: makeFile('a.txt', contentA, 20), loading: false, line: 10 },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();

    const bodyEl = wrapper.find('.fp-body').element as HTMLElement;
    const lineElA = bodyEl.querySelector('[data-line="10"]') as HTMLElement;
    mockScrollGeometry(bodyEl, lineElA, {
      bodyClientHeight: 100,
      lineOffsetTop: 180,
      lineHeight: 20,
    });
    await wrapper.setProps({ file: makeFile('a.txt', contentA, 20), line: 10 });
    await nextTick();
    expect(bodyEl.scrollTop).toBe(140); // 180 - 50 + 10

    // Simulate the user (or a prior file) having scrolled mid-content.
    bodyEl.scrollTop = 500;

    // Switch to a different file at an early line.
    await wrapper.setProps({ file: makeFile('b.txt', contentB, 20), line: 2 });
    await nextTick();

    const lineElB = bodyEl.querySelector('[data-line="2"]') as HTMLElement;
    mockScrollGeometry(bodyEl, lineElB, {
      bodyClientHeight: 100,
      lineOffsetTop: 20,
      lineHeight: 20,
      currentScrollTop: 0,
    });
    await nextTick();

    // Reset + centered: 20 - 50 + 10 = -20, clamped to 0 by the browser.
    expect(bodyEl.scrollTop).toBe(0);
  });
});

describe('FilePreview markdown', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function markdownFile(path: string, content: string): FileData {
    return {
      path,
      content,
      encoding: 'utf-8',
      mime: 'text/markdown',
      isBinary: false,
      size: content.length,
      lineCount: content.split('\n').length,
    };
  }

  it('renders Markdown as rich preview by default', async () => {
    const wrapper = mount(FilePreview, {
      props: { file: markdownFile('README.md', '# Hello\n\nWorld'), loading: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('.fp-markdown').exists()).toBe(true);
    expect(wrapper.find('.fp-markdown').text()).toContain('Hello');
    expect(wrapper.find('.fp-code').exists()).toBe(false);
  });

  it('toggles to source view and back', async () => {
    const wrapper = mount(FilePreview, {
      props: { file: markdownFile('README.md', '# Hello'), loading: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();

    const buttons = wrapper.findAll('.fp-seg-btn');
    expect(buttons.map((b) => b.text())).toEqual(['Preview', 'Source']);

    await buttons[1]!.trigger('click');
    await nextTick();

    expect(wrapper.find('.fp-code').exists()).toBe(true);
    expect(wrapper.find('.fp-code').text()).toContain('# Hello');

    await buttons[0]!.trigger('click');
    await nextTick();

    expect(wrapper.find('.fp-markdown').exists()).toBe(true);
  });

  it('recognises .mdx files as markdown', async () => {
    const wrapper = mount(FilePreview, {
      props: { file: { ...markdownFile('page.mdx', '# MDX'), mime: 'text/plain' }, loading: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('.fp-seg-btn').exists()).toBe(true);
  });

  it('resolves a Markdown relative link against the current file directory', async () => {
    const openFile = vi.fn();
    const wrapper = mount(FilePreview, {
      props: {
        file: markdownFile('docs/guide/page.md', 'See [other](../other.md).'),
        loading: false,
        openFile,
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const link = wrapper.find('.fp-markdown a[href="../other.md"]');
    expect(link.exists()).toBe(true);
    await link.trigger('click');
    await nextTick();

    expect(openFile).toHaveBeenCalledWith({ path: 'docs/other.md' });
  });

  it('resolves a Markdown relative image against the current file directory', async () => {
    const resolveImage = vi.fn(async (src: string) => `resolved:${src}`);
    const wrapper = mount(FilePreview, {
      props: {
        file: markdownFile('docs/guide/page.md', '![img](../img.png)'),
        loading: false,
      },
      global: {
        plugins: [i18n],
        provide: { resolveImage },
      },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    expect(resolveImage).toHaveBeenCalledWith('docs/img.png');
  });

  it('strips fragment and query from Markdown file links before opening', async () => {
    const openFile = vi.fn();
    const wrapper = mount(FilePreview, {
      props: {
        file: markdownFile('docs/page.md', 'See [a](guide.md#section) and [b](other.md?x=1).'),
        loading: false,
        openFile,
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const linkA = wrapper.find('.fp-markdown a[href="guide.md#section"]');
    const linkB = wrapper.find('.fp-markdown a[href="other.md?x=1"]');
    expect(linkA.exists()).toBe(true);
    expect(linkB.exists()).toBe(true);

    await linkA.trigger('click');
    await nextTick();
    await linkB.trigger('click');
    await nextTick();

    expect(openFile).toHaveBeenNthCalledWith(1, { path: 'docs/guide.md' });
    expect(openFile).toHaveBeenNthCalledWith(2, { path: 'docs/other.md' });
  });

  it('does not intercept pure anchor links', async () => {
    const openFile = vi.fn();
    const wrapper = mount(FilePreview, {
      props: {
        file: markdownFile('docs/page.md', 'Jump to [section](#section).'),
        loading: false,
        openFile,
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const link = wrapper.find('.fp-markdown a[href="#section"]');
    expect(link.exists()).toBe(true);
    await link.trigger('click');
    await nextTick();

    expect(openFile).not.toHaveBeenCalled();
  });
});
