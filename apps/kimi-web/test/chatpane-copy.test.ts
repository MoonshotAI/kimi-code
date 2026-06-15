import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ChatPane from '../src/components/ChatPane.vue';
import type { ChatTurn } from '../src/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      conversation: {
        cancel: 'Cancel',
        compactedPlain: 'Context compacted',
        compactedAuto: 'Context auto-compacted',
        compactedTokens: ' ({before} -> {after})',
        confirm: 'Confirm',
        loading: 'Loading',
        undo: 'Undo',
        undoConfirm: 'Undo last message?',
        viewSummary: 'View summary',
        yesterday: 'Yesterday',
      },
      filePreview: { copy: 'Copy' },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

function mountPane(turns: ChatTurn[]) {
  return mount(ChatPane, {
    props: { turns },
    global: {
      plugins: [i18n],
      stubs: {
        Markdown: { props: ['text'], template: '<div class="markdown-stub">{{ text }}</div>' },
        ThinkingBlock: true,
        ToolCall: true,
        ActivityNotice: true,
        AgentCard: true,
        AgentGroup: true,
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChatPane copy', () => {
  it('copies only assistant final text from the per-message copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const turns: ChatTurn[] = [
      {
        id: 'a1',
        role: 'assistant',
        no: 1,
        text: 'Final answer',
        blocks: [
          { kind: 'thinking', thinking: 'private reasoning' },
          {
            kind: 'tool',
            tool: {
              id: 'tool_1',
              name: 'bash',
              arg: 'pnpm test',
              status: 'ok',
              output: ['tool output'],
            },
          },
          { kind: 'text', text: 'Final answer' },
        ],
      },
    ];
    const wrapper = mountPane(turns);

    await wrapper.find('.cpbtn').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith('Final answer');
  });
});
