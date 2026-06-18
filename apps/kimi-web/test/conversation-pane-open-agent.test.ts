import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';

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

const ChatPaneStub = defineComponent({
  name: 'ChatPaneStub',
  emits: ['open-agent'],
  template: `<button data-testid="stub-open-agent" @click="$emit('open-agent', { turnId: 't1', blockIndex: 2, memberId: 'agent_1' })">open</button>`,
});

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
      turns: [{ id: 't1', role: 'assistant' as const, no: 1, text: 'hi' }],
      tasks: [],
      status,
      sessionLoading: false,
      running: false,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatPane: ChatPaneStub,
        Composer: true,
        ChatDock: true,
        SwarmCard: true,
      },
    },
  });
}

describe('ConversationPane open-agent forwarding', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('forwards ChatPane open-agent emits to the parent', async () => {
    const wrapper = mountPane();
    await nextTick();

    await wrapper.find('[data-testid="stub-open-agent"]').trigger('click');
    await nextTick();

    expect(wrapper.emitted('openAgent')).toEqual([
      [{ turnId: 't1', blockIndex: 2, memberId: 'agent_1' }],
    ]);
  });
});
