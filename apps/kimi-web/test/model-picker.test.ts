import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';

import ModelPicker from '../src/components/ModelPicker.vue';
import type { AppModel } from '../src/api/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      model: {
        allTab: 'All',
        close: 'Close',
        contextSuffix: '{size}k ctx',
        dialogLabel: 'Switch model',
        emptyNoMatch: 'No matching models',
        emptyNoModels: 'No models',
        footerHint: 'Navigate',
        loading: 'Loading',
        providerTabs: 'Model providers',
        searchPlaceholder: 'Search',
        title: 'Switch model',
        unavailable: 'Unavailable',
      },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

const models: AppModel[] = [
  {
    id: 'kimi/k2',
    provider: 'kimi',
    model: 'k2',
    displayName: 'Kimi K2',
    maxContextSize: 128000,
  },
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    model: 'gpt-5',
    displayName: 'GPT-5',
    maxContextSize: 256000,
  },
  {
    id: 'openai/gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    displayName: 'GPT-4o',
    maxContextSize: 128000,
  },
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ModelPicker provider tabs', () => {
  it('filters the fixed model list by provider tab', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        models,
        current: 'kimi/k2',
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.findAll('.model-row')).toHaveLength(3);

    await wrapper.findAll('.tab-btn').find((button) => button.text() === 'openai')!.trigger('click');

    expect(wrapper.findAll('.model-row')).toHaveLength(2);
    expect(wrapper.text()).toContain('GPT-5');
    expect(wrapper.text()).not.toContain('Kimi K2');

    await wrapper.findAll('.tab-btn').find((button) => button.text() === 'All')!.trigger('click');

    expect(wrapper.findAll('.model-row')).toHaveLength(3);
  });
});

describe('ModelPicker dialog focus', () => {
  it('is a modal that focuses the search box and restores focus on close', async () => {
    // An opener that "owns" focus before the dialog appears.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const wrapper = mount(ModelPicker, {
      props: { models, current: 'kimi/k2' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });

    const dialog = wrapper.find('.dialog');
    expect(dialog.attributes('aria-modal')).toBe('true');

    await nextTick();
    // Opening moves focus into the dialog (the search field).
    expect(document.activeElement).toBe(wrapper.find('.search-input').element);

    wrapper.unmount();
    await nextTick();
    // Closing returns focus to whoever opened it.
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });
});

describe('ModelPicker starred models', () => {
  it('pins starred models to the top in the All tab', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        models,
        current: 'kimi/k2',
        starredIds: ['openai/gpt-4o'],
      },
      global: { plugins: [i18n] },
    });

    const rows = wrapper.findAll('.model-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('GPT-4o');
    expect(rows[1]!.text()).toContain('Kimi K2');
    expect(rows[2]!.text()).toContain('GPT-5');
  });

  it('does not reorder models inside a provider tab', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        models,
        current: 'kimi/k2',
        starredIds: ['openai/gpt-4o'],
      },
      global: { plugins: [i18n] },
    });

    await wrapper.findAll('.tab-btn').find((button) => button.text() === 'openai')!.trigger('click');

    const rows = wrapper.findAll('.model-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('GPT-5');
    expect(rows[1]!.text()).toContain('GPT-4o');
  });

  it('emits toggle-star when the star button is clicked without selecting the model', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        models,
        current: 'kimi/k2',
        starredIds: [],
      },
      global: { plugins: [i18n] },
    });

    const starBtn = wrapper.findAll('.star-btn').find((button) =>
      button.element.closest('.model-row')?.textContent?.includes('GPT-5'),
    );
    expect(starBtn).toBeDefined();
    await starBtn!.trigger('click');

    expect(wrapper.emitted('toggle-star')).toHaveLength(1);
    expect(wrapper.emitted('toggle-star')![0]).toEqual(['openai/gpt-5']);
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('keeps starred models first while searching in the All tab', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        models,
        current: 'kimi/k2',
        starredIds: ['openai/gpt-5'],
      },
      global: { plugins: [i18n] },
    });

    const search = wrapper.find('.search-input');
    await search.setValue('gpt');

    const rows = wrapper.findAll('.model-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('GPT-5');
    expect(rows[1]!.text()).toContain('GPT-4o');
  });
});
