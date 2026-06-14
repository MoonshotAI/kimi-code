import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import Composer from '../src/components/Composer.vue';

function mountComposer(props: Record<string, unknown> = {}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        composer: {
          editQueued: 'Edit queued',
          interrupt: 'Interrupt',
          interruptTitle: 'Interrupt',
          placeholder: 'Message Kimi',
          queueLabel: 'Queue',
          remove: 'Remove',
          send: 'Send',
          steerNow: 'Steer now',
          steerTitle: 'Steer now',
        },
      },
    },
  });

  return mount(Composer, {
    props,
    global: {
      plugins: [i18n],
    },
  });
}

function waitForCompositionEndTimer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = '';
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('Composer IME input', () => {
  it('does not submit when Enter confirms active composition', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('ni');
    await textarea.trigger('compositionstart');
    await textarea.trigger('keydown', { key: 'Enter', isComposing: true });

    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('does not submit the Enter that immediately follows compositionend', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('你好');
    await textarea.trigger('compositionstart');
    await textarea.trigger('compositionend');
    await textarea.trigger('keydown', { key: 'Enter', isComposing: false });

    expect(wrapper.emitted('submit')).toBeUndefined();

    await waitForCompositionEndTimer();
    await textarea.trigger('keydown', { key: 'Enter', isComposing: false });

    expect(wrapper.emitted('submit')).toEqual([[{ text: '你好', attachments: [] }]]);
  });
});

describe('Composer history recall', () => {
  it('walks sent messages with ArrowUp/ArrowDown and restores the draft', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    await textarea.setValue('first');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('second');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toHaveLength(2);
    expect(el.value).toBe('');

    // ArrowUp recalls the most recent, then the older one.
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('second');
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('first');

    // ArrowDown walks forward, then restores the (empty) live draft.
    await textarea.trigger('keydown', { key: 'ArrowDown' });
    expect(el.value).toBe('second');
    await textarea.trigger('keydown', { key: 'ArrowDown' });
    expect(el.value).toBe('');
  });

  it('keeps walking past a multi-line entry (caret lands off the first line)', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    // Three sends; the middle one is multi-line. After recalling it the caret
    // sits on its LAST line, so the old "ArrowUp only on the first line" gate
    // trapped it there and you could never reach the oldest entry.
    await textarea.setValue('oldest');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('multi\nline');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('newest');
    await textarea.trigger('keydown', { key: 'Enter' });

    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('newest');
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('multi\nline');
    // The fix: still recalls the oldest even though the caret is on the last
    // line of the multi-line entry.
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('oldest');
  });
});

describe('Composer draft persistence', () => {
  it('saves the unsent draft per session and restores it on switch', async () => {
    const wrapper = mountComposer({ sessionId: 'sess_A' });
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    await textarea.setValue('draft for A');
    expect(localStorage.getItem('kimi-web.draft.sess_A')).toBe('draft for A');

    // Switch to another session → box clears (B has no draft), A is preserved.
    await wrapper.setProps({ sessionId: 'sess_B' });
    expect(el.value).toBe('');
    await textarea.setValue('draft for B');

    // Back to A → its draft comes back.
    await wrapper.setProps({ sessionId: 'sess_A' });
    expect(el.value).toBe('draft for A');
    // B's draft is still stored too.
    expect(localStorage.getItem('kimi-web.draft.sess_B')).toBe('draft for B');
  });

  it('restores a saved draft on mount and clears it after sending', async () => {
    localStorage.setItem('kimi-web.draft.sess_X', 'unfinished');
    const wrapper = mountComposer({ sessionId: 'sess_X' });
    const textarea = wrapper.get('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('unfinished');

    await textarea.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toHaveLength(1);
    // Draft cleared once sent.
    expect(localStorage.getItem('kimi-web.draft.sess_X')).toBe(null);
  });
});

describe('Composer queue bubble', () => {
  it('keeps queued prompts collapsed until the queue bubble is opened', async () => {
    const wrapper = mountComposer({
      queued: [{ text: 'follow up after this', attachmentCount: 0 }],
    });

    expect(wrapper.find('.queue-popover').exists()).toBe(false);
    expect(wrapper.find('.queue-bubble').exists()).toBe(true);

    await wrapper.find('.queue-bubble').trigger('click');

    expect(wrapper.find('.queue-popover').exists()).toBe(true);
    expect(wrapper.find('.queue-text-inner').text()).toBe('follow up after this');
  });
});
