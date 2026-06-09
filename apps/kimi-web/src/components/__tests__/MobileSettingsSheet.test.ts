// apps/kimi-web/src/components/__tests__/MobileSettingsSheet.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MobileSettingsSheet from '../MobileSettingsSheet.vue';
import i18n from '../../i18n';
import type { ConversationStatus } from '../../types';

const global = { plugins: [i18n] };

const status: ConversationStatus = {
  model: 'kimi-for-coding',
  ctxUsed: 15000,
  ctxMax: 262000,
  permission: 'manual',
  branch: 'main',
  cwd: '/code/kimi-web',
  isGitRepo: true,
};

function factory(props: Partial<InstanceType<typeof MobileSettingsSheet>['$props']> = {}) {
  return mount(MobileSettingsSheet, {
    props: { modelValue: true, status, thinking: 'high', planMode: false, ...props },
    global,
  });
}

describe('MobileSettingsSheet', () => {
  it('渲染模型/思考/计划/权限/上下文五行', () => {
    const w = factory();
    const rows = w.findAll('.srow');
    expect(rows).toHaveLength(5);
    expect(w.text()).toContain('kimi-for-coding'); // model sub
    expect(w.text()).toContain('high'); // thinking value
    expect(w.find('.toggle').exists()).toBe(true); // plan toggle
    expect(w.find('.ctx-meter').exists()).toBe(true); // context meter
  });

  it('点击模型行 emit pickModel 并关闭 sheet', async () => {
    const w = factory();
    await w.findAll('.srow')[0]!.trigger('click');
    expect(w.emitted('pickModel')).toBeTruthy();
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('点击思考行循环到下一档', async () => {
    const w = factory({ thinking: 'high' });
    await w.findAll('.srow')[1]!.trigger('click');
    expect(w.emitted('setThinking')?.[0]).toEqual(['xhigh']);
  });

  it('点击计划行 emit togglePlan', async () => {
    const w = factory();
    await w.findAll('.srow')[2]!.trigger('click');
    expect(w.emitted('togglePlan')).toBeTruthy();
  });

  it('planMode=true 时 toggle 高亮', () => {
    const w = factory({ planMode: true });
    expect(w.find('.toggle').classes()).toContain('on');
  });

  it('点击权限行循环 manual → auto', async () => {
    const w = factory();
    await w.findAll('.srow')[3]!.trigger('click');
    expect(w.emitted('setPermission')?.[0]).toEqual(['auto']);
  });

  it('上下文行只读，显示用量', () => {
    const w = factory();
    const ctxRow = w.findAll('.srow')[4]!;
    expect(ctxRow.classes()).toContain('read-only');
    expect(w.text()).toContain('15k / 262k');
  });
});
