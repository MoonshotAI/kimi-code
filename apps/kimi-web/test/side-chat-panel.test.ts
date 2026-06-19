import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import SideChatPanel from '../src/components/SideChatPanel.vue';
import type { ChatTurn } from '../src/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      sideChat: {
        title: 'Side chat',
        subtitle: 'Ask a follow-up',
        placeholder: 'Ask a question…',
        send: 'Send',
        empty: 'No messages yet.',
      },
      thinking: { close: 'Close' },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

function mockBodyScroll(el: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: 0,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SideChatPanel', () => {
  it('scrolls to bottom when Enter sends a message', async () => {
    const wrapper = mount(SideChatPanel, {
      props: { turns: [], running: false, sending: false },
      global: {
        plugins: [i18n],
        stubs: { ChatPane: true },
      },
      attachTo: document.body,
    });
    await nextTick();

    const bodyEl = wrapper.find('.sc-body').element as HTMLElement;
    mockBodyScroll(bodyEl, 500);

    const textarea = wrapper.get('textarea');
    await textarea.setValue('hello');
    await textarea.trigger('keydown', { key: 'Enter', isComposing: false });
    await nextTick();

    expect(bodyEl.scrollTop).toBe(500);
    expect(wrapper.emitted('send')).toEqual([['hello']]);
  });

  it('keeps scrolling to bottom while a response streams in', async () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', no: 1, text: 'hello' },
      { id: 'a1', role: 'assistant', no: 2, text: '' },
    ];

    const wrapper = mount(SideChatPanel, {
      props: { turns, running: true, sending: false },
      global: {
        plugins: [i18n],
        stubs: { ChatPane: true },
      },
      attachTo: document.body,
    });
    await nextTick();

    const bodyEl = wrapper.find('.sc-body').element as HTMLElement;
    mockBodyScroll(bodyEl, 800);

    await wrapper.setProps({
      turns: [
        { id: 'u1', role: 'user', no: 1, text: 'hello' },
        { id: 'a1', role: 'assistant', no: 2, text: 'first line' },
      ],
    });
    await nextTick();

    expect(bodyEl.scrollTop).toBe(800);
  });

  it('does not auto-scroll while the panel is idle', async () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', no: 1, text: 'hello' },
    ];

    const wrapper = mount(SideChatPanel, {
      props: { turns, running: false, sending: false },
      global: {
        plugins: [i18n],
        stubs: { ChatPane: true },
      },
      attachTo: document.body,
    });
    await nextTick();

    const bodyEl = wrapper.find('.sc-body').element as HTMLElement;
    mockBodyScroll(bodyEl, 300);
    bodyEl.scrollTop = 50;

    await wrapper.setProps({
      turns: [
        { id: 'u1', role: 'user', no: 1, text: 'hello' },
        { id: 'u2', role: 'user', no: 2, text: 'later' },
      ],
    });
    await nextTick();

    expect(bodyEl.scrollTop).toBe(50);
  });

  it('renders a header with title, first user message subtitle, and a close button', async () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', no: 1, text: 'explain this code' },
    ];

    const wrapper = mount(SideChatPanel, {
      props: { turns, running: false, sending: false },
      global: {
        plugins: [i18n],
        stubs: { ChatPane: true },
      },
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('.sc-header').exists()).toBe(true);
    expect(wrapper.find('.sc-title').text()).toBe('Side chat');
    expect(wrapper.find('.sc-subtitle').text()).toBe('explain this code');

    await wrapper.find('.sc-close').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('uses the title prop when provided', async () => {
    const wrapper = mount(SideChatPanel, {
      props: { turns: [], running: false, sending: false, title: 'Custom title' },
      global: {
        plugins: [i18n],
        stubs: { ChatPane: true },
      },
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('.sc-title').text()).toBe('Custom title');
  });
});
