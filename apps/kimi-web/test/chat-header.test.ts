import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';

import ChatHeader from '../src/components/ChatHeader.vue';
import enHeader from '../src/i18n/locales/en/header';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { header: enHeader } },
  missingWarn: false,
  fallbackWarn: false,
});

describe('ChatHeader', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('emits openChanges when the git status area is clicked', async () => {
    const wrapper = mount(ChatHeader, {
      props: {
        isGitRepo: true,
        branch: 'main',
        ahead: 0,
        behind: 0,
        changesCount: 3,
        gitDiffStats: { totalAdditions: 10, totalDeletions: 2 },
      },
      global: { plugins: [i18n] },
    });

    await wrapper.find('.ch-git').trigger('click');

    expect(wrapper.emitted('openChanges')).toHaveLength(1);
  });

  it('does not render the git button for a non-git workspace', () => {
    const wrapper = mount(ChatHeader, {
      props: { isGitRepo: false },
      global: { plugins: [i18n] },
    });

    expect(wrapper.find('.ch-git').exists()).toBe(false);
  });

  it('renders the full branch name and exposes it via title', () => {
    const branch = 'feat/web-session-lazy-loading/very-long-branch-name-for-header-display';

    const wrapper = mount(ChatHeader, {
      props: {
        isGitRepo: true,
        branch,
      },
      global: { plugins: [i18n] },
    });

    const branchEl = wrapper.find('.ch-branch');

    expect(branchEl.text()).toBe(branch);
    expect(branchEl.attributes('title')).toBe(branch);
  });

  it('renders the detached label with title when branch is empty', () => {
    const wrapper = mount(ChatHeader, {
      props: { isGitRepo: true },
      global: { plugins: [i18n] },
    });

    const branchEl = wrapper.find('.ch-branch');

    expect(branchEl.text()).toBe('detached');
    expect(branchEl.attributes('title')).toBe('detached');
  });
});
