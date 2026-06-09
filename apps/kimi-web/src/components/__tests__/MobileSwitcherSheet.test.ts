// apps/kimi-web/src/components/__tests__/MobileSwitcherSheet.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MobileSwitcherSheet from '../MobileSwitcherSheet.vue';
import i18n from '../../i18n';
import type { Session, WorkspaceView } from '../../types';

const global = { plugins: [i18n] };

const workspaces: WorkspaceView[] = [
  { id: 'w1', name: 'kimi-web', root: '/code/kimi-web', shortPath: '~/code/kimi-web', sessionCount: 2 },
  { id: 'w2', name: 'paseo', root: '/code/paseo', shortPath: '~/code/paseo', sessionCount: 1 },
];

const sessions: Session[] = [
  { id: 's1', title: 'fix-login-oauth', time: 'just now', status: 'running' },
  { id: 's2', title: 'add-tests', time: '2h ago', status: 'idle' },
];

function factory(props: Partial<InstanceType<typeof MobileSwitcherSheet>['$props']> = {}) {
  return mount(MobileSwitcherSheet, {
    props: {
      modelValue: true,
      workspaces,
      activeWorkspace: workspaces[0]!,
      activeWorkspaceId: 'w1',
      sessions,
      activeId: 's1',
      ...props,
    },
    global,
  });
}

describe('MobileSwitcherSheet', () => {
  it('渲染工作区 chip 行与会话列表', () => {
    const w = factory();
    // 2 workspace chips + 1 add chip
    expect(w.findAll('.wschip')).toHaveLength(3);
    // sessions rendered as prototype .srow rows
    expect(w.findAll('.srow')).toHaveLength(2);
    expect(w.text()).toContain('fix-login-oauth');
    expect(w.text()).toContain('add-tests');
  });

  it('点击会话 emit select 并关闭 sheet', async () => {
    const w = factory();
    const rows = w.findAll('.srow');
    await rows[1]!.trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['s2']);
    // selecting a session also closes the sheet
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('运行中会话显示 run 状态点，当前会话高亮', () => {
    const w = factory();
    const rows = w.findAll('.srow');
    // s1 is running + the active session
    expect(rows[0]!.find('.d').classes()).toContain('run');
    expect(rows[0]!.classes()).toContain('cur');
    // s2 is idle, not active
    expect(rows[1]!.find('.d').classes()).not.toContain('run');
    expect(rows[1]!.classes()).not.toContain('cur');
  });

  it('点击工作区 chip emit selectWorkspace 且不关闭', async () => {
    const w = factory();
    await w.findAll('.wschip')[1]!.trigger('click');
    expect(w.emitted('selectWorkspace')?.[0]).toEqual(['w2']);
    // workspace switch keeps the sheet open
    expect(w.emitted('update:modelValue')).toBeFalsy();
  });

  it('点击 + New emit create 并关闭', async () => {
    const w = factory();
    await w.find('.newrow').trigger('click');
    expect(w.emitted('create')).toBeTruthy();
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('点击添加工作区 chip emit addWorkspace', async () => {
    const w = factory();
    await w.find('.wschip.add').trigger('click');
    expect(w.emitted('addWorkspace')).toBeTruthy();
  });

  it('无会话时显示空态', () => {
    const w = factory({ sessions: [] });
    expect(w.find('.mempty').exists()).toBe(true);
    expect(w.findAllComponents({ name: 'SessionRow' })).toHaveLength(0);
  });
});
