import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ChatPane from '../src/components/ChatPane.vue';
import type { ChatTurn } from '../src/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      conversation: {
        undo: 'Undo',
        undoConfirm: 'Undo last message?',
        confirm: 'Confirm',
        cancel: 'Cancel',
        loading: 'Loading',
      },
      filePreview: { copy: 'Copy' },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

const turns: ChatTurn[] = [{ id: 'u1', role: 'user', no: 1, text: 'hello' }];

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatPane undo animation', () => {
  it('waits for the exit animation before emitting editMessage', async () => {
    vi.useFakeTimers();
    const wrapper = mount(ChatPane, {
      props: { turns, mobile: true },
      global: {
        plugins: [i18n],
        stubs: {
          Markdown: true,
          ThinkingBlock: true,
          ToolCall: true,
          ActivityNotice: true,
          AgentCard: true,
          AgentGroup: true,
        },
      },
    });

    await wrapper.find('.u-edit').trigger('click');
    await wrapper.find('.u-edit-confirm-btn.confirm').trigger('click');

    expect(wrapper.emitted('editMessage')).toBeUndefined();
    expect(wrapper.find('.u-bub').classes()).toContain('undoing');

    vi.advanceTimersByTime(240);
    await nextTick();

    expect(wrapper.emitted('editMessage')?.[0]).toEqual(['hello']);
  });
});
