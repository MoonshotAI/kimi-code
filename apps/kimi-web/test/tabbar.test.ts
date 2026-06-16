// apps/kimi-web/test/tabbar.test.ts
//
// TabBar accessibility: the two persistent tabs (chat / files) plus any
// transient tabs (preview / btw) are a real ARIA tablist — buttons with
// role="tab", aria-selected on the active one, roving tabindex, and
// Left/Right/Home/End keyboard navigation.

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';

import TabBar from '../src/components/TabBar.vue';
import enSidebar from '../src/i18n/locales/en/sidebar';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { sidebar: enSidebar } },
  missingWarn: false,
  fallbackWarn: false,
});

function mountTabBar(props: Record<string, unknown> = {}) {
  return mount(TabBar, {
    props: { active: 'chat', ...props },
    global: { plugins: [i18n] },
  });
}

describe('TabBar accessibility', () => {
  it('renders a tablist of buttons with role=tab', () => {
    const wrapper = mountTabBar();
    const list = wrapper.find('[role="tablist"]');
    expect(list.exists()).toBe(true);
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs).toHaveLength(2); // chat + files only by default
    expect(tabs.every((t) => t.element.tagName === 'BUTTON')).toBe(true);
    expect(tabs.map((t) => t.text())).toEqual(['chat', 'files']);
  });

  it('marks the active tab with aria-selected and a tabbable roving index', () => {
    const wrapper = mountTabBar({ active: 'files' });
    const tabs = wrapper.findAll('[role="tab"]');
    const [chat, files] = tabs;
    expect(chat!.attributes('aria-selected')).toBe('false');
    expect(files!.attributes('aria-selected')).toBe('true');
    // Only the active tab participates in the Tab sequence.
    expect(chat!.attributes('tabindex')).toBe('-1');
    expect(files!.attributes('tabindex')).toBe('0');
  });

  it('shows transient preview / btw tabs only when hosted', () => {
    const wrapper = mountTabBar({ hasPreview: true, hasBtw: true });
    expect(wrapper.findAll('[role="tab"]').map((t) => t.text())).toEqual([
      'chat',
      'files',
      'Side chat',
      'preview',
    ]);
  });

  it('emits select on click', async () => {
    const wrapper = mountTabBar();
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['files']);
  });

  it('moves selection with Arrow keys (wrapping) and Home/End', async () => {
    const wrapper = mountTabBar({ active: 'chat' });
    const list = wrapper.find('[role="tablist"]');

    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['files']);

    await list.trigger('keydown', { key: 'ArrowLeft' });
    // From chat (the prop hasn't changed), Left wraps to the last tab → files.
    expect(wrapper.emitted('select')?.[1]).toEqual(['files']);

    await list.trigger('keydown', { key: 'End' });
    expect(wrapper.emitted('select')?.[2]).toEqual(['files']);
  });

  it('associates tabs with their panel when a panelId is given', () => {
    const wrapper = mountTabBar({ active: 'chat', panelId: 'pane-g1' });
    const chat = wrapper.findAll('[role="tab"]')[0]!;
    expect(chat.attributes('id')).toBe('pane-g1__chat');
    expect(chat.attributes('aria-controls')).toBe('pane-g1');
  });
});
