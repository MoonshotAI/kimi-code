// apps/kimi-web/src/components/__tests__/BottomSheet.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BottomSheet from '../BottomSheet.vue';
import i18n from '../../i18n';

const global = { plugins: [i18n] };

describe('BottomSheet', () => {
  it('modelValue=false 时不渲染面板', () => {
    const w = mount(BottomSheet, { props: { modelValue: false }, global });
    expect(w.find('.sheet-panel').exists()).toBe(false);
  });

  it('modelValue=true 时渲染面板、抓手与插槽内容', () => {
    const w = mount(BottomSheet, {
      props: { modelValue: true, title: 'Hi' },
      slots: { default: '<p class="slotted">body</p>' },
      global,
    });
    expect(w.find('.sheet-panel').exists()).toBe(true);
    expect(w.find('.sheet-grab').exists()).toBe(true);
    expect(w.find('.slotted').exists()).toBe(true);
    expect(w.text()).toContain('Hi');
  });

  it('点击 scrim 关闭（emit update:modelValue=false + close）', async () => {
    const w = mount(BottomSheet, { props: { modelValue: true }, global });
    await w.find('.sheet-scrim').trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false]);
    expect(w.emitted('close')).toBeTruthy();
  });

  it('点击抓手关闭', async () => {
    const w = mount(BottomSheet, { props: { modelValue: true }, global });
    await w.find('.sheet-grab').trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false]);
    expect(w.emitted('close')).toBeTruthy();
  });
});
