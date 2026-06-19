// apps/kimi-web/test/sidebar-search.test.ts
//
// The sidebar search box filters the already-loaded sessions instantly by
// title + last prompt (case-insensitive substring), across all workspaces.

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';

import Sidebar from '../src/components/Sidebar.vue';
import enWorkspace from '../src/i18n/locales/en/workspace';
import enSidebar from '../src/i18n/locales/en/sidebar';
import enSettings from '../src/i18n/locales/en/settings';
import type { Session } from '../src/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { workspace: enWorkspace, sidebar: enSidebar, settings: enSettings } },
  missingWarn: false,
  fallbackWarn: false,
});

const sessions: Session[] = [
  { id: 's1', title: 'Refactor auth', time: '1m', status: 'idle', busy: false, lastPrompt: 'extract the token refresh logic' },
  { id: 's2', title: 'Fix tests', time: '2m', status: 'idle', busy: false, lastPrompt: 'make the sidebar spec pass' },
  { id: 's3', title: 'Write docs', time: '3m', status: 'idle', busy: false },
];

function mountSidebar() {
  return mount(Sidebar, {
    props: {
      activeWorkspace: null,
      activeWorkspaceId: null,
      sessions,
      groups: [],
      activeId: '',
    },
    global: {
      plugins: [i18n],
      stubs: { LanguageSwitcher: true },
    },
  });
}

describe('Sidebar session search', () => {
  it('shows the grouped list when the query is empty', () => {
    const wrapper = mountSidebar();
    expect(wrapper.find('.search-input').exists()).toBe(true);
    // No flat results / no "no results" empty state rendered while not searching.
    expect(wrapper.text()).not.toContain('No matching sessions');
  });

  it('filters by title (case-insensitive)', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('.search-input').setValue('refactor');

    expect(wrapper.text()).toContain('Refactor auth');
    expect(wrapper.text()).not.toContain('Fix tests');
    expect(wrapper.text()).not.toContain('Write docs');
  });

  it('filters by last prompt', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('.search-input').setValue('sidebar spec');

    expect(wrapper.text()).toContain('Fix tests');
    expect(wrapper.text()).not.toContain('Refactor auth');
  });

  it('shows an empty state when nothing matches', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('.search-input').setValue('zzzz-no-match');

    expect(wrapper.text()).toContain('No matching sessions');
  });

  it('clears the query and restores the grouped list', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('.search-input').setValue('refactor');
    expect(wrapper.find('.search-clear').exists()).toBe(true);

    await wrapper.find('.search-clear').trigger('click');
    expect(wrapper.find('.search-clear').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('No matching sessions');
  });

  it('clears the query on Escape so it does not bubble to abort a run', async () => {
    const wrapper = mountSidebar();
    const input = wrapper.find('.search-input');
    await input.setValue('refactor');
    expect(wrapper.find('.search-clear').exists()).toBe(true);

    await input.trigger('keydown', { key: 'Escape' });

    // Query cleared → back to the grouped list, no results panel.
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).not.toContain('No matching sessions');
  });
});
