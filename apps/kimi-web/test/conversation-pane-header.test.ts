import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { ConversationStatus } from '../src/types';

const status: ConversationStatus = {
  model: 'kimi-test',
  modelId: 'kimi-test',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/repo',
  isGitRepo: true,
};

const turns = [{ id: 't1', role: 'user' as const, no: 1, text: 'hi' }];

function mountPane() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  return mount(ConversationPane, {
    attachTo: document.body,
    props: {
      mobile: false,
      turns,
      tasks: [],
      status,
      gitInfo: { branch: 'main', ahead: 0, behind: 0 },
      changes: [{ path: 'a.ts', status: 'modified' }],
      gitDiffStats: { totalAdditions: 5, totalDeletions: 1 },
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatPane: true,
        Composer: true,
        ChatDock: true,
        SwarmCard: true,
      },
    },
  });
}

describe('ConversationPane header', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('forwards openChanges from ChatHeader', async () => {
    const wrapper = mountPane();
    await nextTick();

    await wrapper.find('.ch-git').trigger('click');

    expect(wrapper.emitted('openChanges')).toHaveLength(1);
  });
});
