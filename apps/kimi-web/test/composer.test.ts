import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from '../src/components/Composer.vue';
import type { AppModel } from '../src/api/types';

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
          previewAttachment: 'Preview {name}',
          remove: 'Remove',
          removeNamed: 'Remove {name}',
          send: 'Send',
          steerNow: 'Steer now',
          steerTitle: 'Steer now',
        },
        commands: {
          goal: { desc: 'Start a goal' },
          swarm: { desc: 'Run with swarm' },
          btw: { desc: 'Ask side chat' },
          compact: { desc: 'Compact context' },
        },
        status: {
          modelTooltip: 'Switch model',
          starredModels: 'Starred',
          moreModels: 'More models…',
          thinkingLabel: 'thinking',
        },
      },
    },
    missingWarn: false,
    fallbackWarn: false,
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
  vi.restoreAllMocks();
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

  it('stays empty when a new session is created right after sending from the empty state', async () => {
    const wrapper = mountComposer({ sessionId: undefined });
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    await textarea.setValue('hello');
    await textarea.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(el.value).toBe('');

    // Parent creates a new session and passes its id down to the composer.
    await wrapper.setProps({ sessionId: 'sess_new' });
    await flushPromises();

    expect(el.value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.sess_new')).toBe(null);
  });
});

describe('Composer height', () => {
  it('does not write an autosized textarea height as text grows', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;
    el.style.height = '180px';

    await textarea.setValue('one line\nsecond line\nthird line');

    expect(el.style.height).toBe('');
  });
});

describe('Composer attachment preview', () => {
  it('opens a pasted image preview from the attachment thumbnail', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:preview'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
    const wrapper = mountComposer({
      uploadImage: vi.fn(async () => ({ fileId: 'file_1', name: 'shot.png', mediaType: 'image/png' })),
    });
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [file] },
    });

    document.dispatchEvent(paste);
    await flushPromises();

    await wrapper.find('.att-preview').trigger('click');

    expect(wrapper.find('.att-lightbox').exists()).toBe(true);
    expect(wrapper.find('.att-lightbox-media').attributes('src')).toBe('blob:preview');

    Object.defineProperty(URL, 'createObjectURL', {
      value: originalCreateObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: originalRevokeObjectURL,
      configurable: true,
    });
  });
});

describe('Composer slash command input', () => {
  it('emits /goal with the typed objective instead of sending it as chat', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('/goal swarm review the changed files');
    await textarea.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('command')).toEqual([['/goal swarm review the changed files']]);
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('emits /swarm with the typed task instead of sending it as chat', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('/swarm inspect flaky tests');
    await textarea.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('command')).toEqual([['/swarm inspect flaky tests']]);
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('keeps input-capable slash commands in the composer when selected from the menu', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('/go');
    await textarea.trigger('keydown', { key: 'Enter' });

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/goal ');
    expect(wrapper.emitted('command')).toBeUndefined();
  });
});

describe('Composer model dropdown', () => {
  const models: AppModel[] = [
    { id: 'kimi/k2', provider: 'kimi', model: 'k2', displayName: 'Kimi K2', maxContextSize: 128000 },
    { id: 'openai/gpt-5', provider: 'openai', model: 'gpt-5', displayName: 'GPT-5', maxContextSize: 256000 },
    { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o', displayName: 'GPT-4o', maxContextSize: 128000 },
  ];

  it('shows starred models from other providers in the quick-switch dropdown', async () => {
    const wrapper = mountComposer({
      status: { model: 'Kimi K2', modelId: 'kimi/k2', ctxUsed: 0, ctxMax: 128000, permission: 'manual' },
      models,
      starredIds: ['openai/gpt-5'],
    });

    await wrapper.find('.model-pill').trigger('click');

    const rows = wrapper.findAll('.md-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain('Starred');
    expect(wrapper.text()).toContain('GPT-5');
    expect(wrapper.text()).toContain('openai');
  });

  it('emits selectModel when a starred model is chosen', async () => {
    const wrapper = mountComposer({
      status: { model: 'Kimi K2', modelId: 'kimi/k2', ctxUsed: 0, ctxMax: 128000, permission: 'manual' },
      models,
      starredIds: ['openai/gpt-5'],
    });

    await wrapper.find('.model-pill').trigger('click');
    const starredRow = wrapper.findAll('.md-row').find((row) => row.text().includes('GPT-5'));
    expect(starredRow).toBeDefined();
    await starredRow!.trigger('click');

    expect(wrapper.emitted('selectModel')).toEqual([['openai/gpt-5']]);
  });
});

describe('Composer context indicator', () => {
  const status = { model: 'Kimi K2', modelId: 'kimi/k2', ctxUsed: 0, ctxMax: 128000, permission: 'manual' };

  it('shows the ctx-group by default when status is available', () => {
    const wrapper = mountComposer({ status });

    expect(wrapper.find('.ctx-group').exists()).toBe(true);
  });

  it('hides the ctx-group when hideContext is true', () => {
    const wrapper = mountComposer({ status, hideContext: true });

    expect(wrapper.find('.ctx-group').exists()).toBe(false);
  });

  it('still shows the model pill when ctx-group is hidden', () => {
    const wrapper = mountComposer({ status, hideContext: true });

    expect(wrapper.find('.model-pill').exists()).toBe(true);
  });
});
