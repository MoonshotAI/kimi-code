// apps/kimi-web/src/components/__tests__/TabBar.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TabBar from '../TabBar.vue';
import i18n from '../../i18n';

// TabBar now uses vue-i18n for the alignment toggle labels.
const global = { plugins: [i18n] };

describe('TabBar', () => {
  it('渲染三个标签（diff 已并入 files）且默认 chat 选中', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 2 }, global });
    const tabs = w.findAll('.tb');
    expect(tabs).toHaveLength(3);
    expect(w.text()).toContain('chat');
    expect(w.text()).toContain('files');
    expect(w.text()).toContain('tasks');
    expect(w.text()).not.toContain('diff');
    expect(tabs[0]!.classes()).toContain('on');
  });

  it('tasks 标签显示运行中计数', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 2 }, global });
    expect(w.get('.cnt').text()).toBe('2');
  });

  it('点击标签 emit select 事件', async () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 2 }, global });
    await w.findAll('.tb')[1]!.trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['files']);
  });

  it('changesCount > 0 时 files 显示指示点', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0, changesCount: 3 }, global });
    expect(w.find('.d').exists()).toBe(true);
  });

  it('changesCount = 0 时 ~/files 不显示指示点', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0, changesCount: 0 }, global });
    expect(w.find('.d').exists()).toBe(false);
  });

  it('不传 changesCount 时 files 不显示指示点', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0 }, global });
    expect(w.find('.d').exists()).toBe(false);
  });

  it('渲染对齐切换的左/居中两个按钮', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0 }, global });
    expect(w.findAll('.align-btn')).toHaveLength(2);
  });

  it('align=center 时居中按钮高亮（默认）', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0, align: 'center' }, global });
    const btns = w.findAll('.align-btn');
    expect(btns[0]!.classes()).not.toContain('on'); // left
    expect(btns[1]!.classes()).toContain('on'); // center
  });

  it('align=left 时左对齐按钮高亮', () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0, align: 'left' }, global });
    const btns = w.findAll('.align-btn');
    expect(btns[0]!.classes()).toContain('on');
    expect(btns[1]!.classes()).not.toContain('on');
  });

  it('点击对齐按钮 emit setAlign 事件', async () => {
    const w = mount(TabBar, { props: { active: 'chat', runningTasks: 0, align: 'center' }, global });
    await w.findAll('.align-btn')[0]!.trigger('click');
    expect(w.emitted('setAlign')?.[0]).toEqual(['left']);
  });
});
