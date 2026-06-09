// apps/kimi-web/src/components/__tests__/WorkspaceRail.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import WorkspaceRail from '../WorkspaceRail.vue';
import type { WorkspaceView } from '../../types';

const global = { plugins: [i18n] };

const wsA: WorkspaceView = {
  id: 'wd_a_000000000000',
  name: 'kimi-code-web',
  root: '/Users/me/kimi-code-web',
  shortPath: '~/kimi-code-web',
  branch: 'main',
  sessionCount: 5,
};
const wsB: WorkspaceView = {
  id: 'wd_b_000000000000',
  name: 'paseo',
  root: '/Users/me/paseo',
  shortPath: '~/paseo',
  branch: 'dev',
  sessionCount: 2,
};

describe('WorkspaceRail', () => {
  it('每个工作区渲染一个 chip，首字母大写', () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsA.id },
      global,
    });
    const chips = w.findAll('.wschip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.text()).toContain('K'); // kimi-code-web → K
    expect(chips[1]!.text()).toContain('P'); // paseo → P
  });

  it('活动工作区 chip 带 .on 高亮', () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsB.id },
      global,
    });
    const chips = w.findAll('.wschip');
    expect(chips[0]!.classes()).not.toContain('on');
    expect(chips[1]!.classes()).toContain('on');
  });

  it('attentionByWorkspace > 0 的 chip 显示带计数的徽标', () => {
    const w = mount(WorkspaceRail, {
      props: {
        workspaces: [wsA, wsB],
        activeId: wsA.id,
        attentionByWorkspace: { [wsB.id]: 3 },
      },
      global,
    });
    const chips = w.findAll('.wschip');
    expect(chips[0]!.find('.badge').exists()).toBe(false);
    const badge = chips[1]!.find('.badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('3');
  });

  it('点击 chip 发出 select 事件并带工作区 id', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsA.id },
      global,
    });
    await w.findAll('.wschip')[1]!.trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0]).toEqual([wsB.id]);
  });

  it('点击 + 按钮发出 addWorkspace 事件', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id },
      global,
    });
    await w.find('.railadd').trigger('click');
    expect(w.emitted('addWorkspace')).toBeTruthy();
  });

  it('已登录时账户弹层展示登出，发出 logout 事件', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id, authReady: true, accountModel: 'kimi-for-coding' },
      global,
    });
    await w.find('.avachip').trigger('click');
    expect(w.text()).toContain('managed:kimi-code');
    expect(w.text()).toContain('kimi-for-coding');
    const signOut = w.findAll('.am-item').find((el) => el.text().includes('Sign out'));
    await signOut!.trigger('click');
    expect(w.emitted('logout')).toBeTruthy();
  });

  it('未登录时账户弹层展示登录，发出 login 事件', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id, authReady: false },
      global,
    });
    expect(w.find('.avachip').classes()).toContain('off');
    await w.find('.avachip').trigger('click');
    const signIn = w.findAll('.am-item').find((el) => el.text().includes('Sign in'));
    await signIn!.trigger('click');
    expect(w.emitted('login')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Expand / collapse toggle
  // -------------------------------------------------------------------------

  it('折叠态（默认）只显示首字母，不显示工作区名', () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsA.id },
      global,
    });
    expect(w.find('.rail').classes()).not.toContain('expanded');
    expect(w.findAll('.chip-name')).toHaveLength(0);
    expect(w.text()).not.toContain('kimi-code-web');
  });

  it('展开态显示工作区名与会话数', () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsA.id, expanded: true },
      global,
    });
    expect(w.find('.rail').classes()).toContain('expanded');
    const names = w.findAll('.wschip .chip-name').map((el) => el.text());
    expect(names).toContain('kimi-code-web');
    expect(names).toContain('paseo');
    // session counts surface in expanded rows
    const counts = w.findAll('.chip-count').map((el) => el.text());
    expect(counts).toEqual(['5', '2']);
  });

  it('展开态活动工作区行带 .on 高亮', () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA, wsB], activeId: wsB.id, expanded: true },
      global,
    });
    const chips = w.findAll('.wschip');
    expect(chips[0]!.classes()).not.toContain('on');
    expect(chips[1]!.classes()).toContain('on');
  });

  it('点击切换按钮发出 toggleExpand 事件', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id },
      global,
    });
    await w.find('.railtoggle').trigger('click');
    expect(w.emitted('toggleExpand')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Theme toggle (bottom-left account popover)
  // -------------------------------------------------------------------------

  it('账户弹层展示 Terminal | Modern 主题切换，当前主题高亮', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id, authReady: true, theme: 'terminal' },
      global,
    });
    await w.find('.avachip').trigger('click');
    const opts = w.findAll('.theme-opt');
    expect(opts).toHaveLength(2);
    expect(opts[0]!.text()).toBe('Terminal');
    expect(opts[1]!.text()).toBe('Modern');
    // terminal is active → first option carries .on
    expect(opts[0]!.classes()).toContain('on');
    expect(opts[1]!.classes()).not.toContain('on');
  });

  it('点击 Modern 选项发出 setTheme=modern', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id, authReady: true, theme: 'terminal' },
      global,
    });
    await w.find('.avachip').trigger('click');
    const opts = w.findAll('.theme-opt');
    await opts[1]!.trigger('click');
    expect(w.emitted('setTheme')).toBeTruthy();
    expect(w.emitted('setTheme')![0]).toEqual(['modern']);
  });

  it('未登录时主题切换仍可用（弹层在两种登录态都展示）', async () => {
    const w = mount(WorkspaceRail, {
      props: { workspaces: [wsA], activeId: wsA.id, authReady: false, theme: 'modern' },
      global,
    });
    await w.find('.avachip').trigger('click');
    const opts = w.findAll('.theme-opt');
    expect(opts).toHaveLength(2);
    // modern is active → second option carries .on
    expect(opts[1]!.classes()).toContain('on');
    await opts[0]!.trigger('click');
    expect(w.emitted('setTheme')![0]).toEqual(['terminal']);
  });

  it('展开态仍渲染工作区徽标', () => {
    const w = mount(WorkspaceRail, {
      props: {
        workspaces: [wsA, wsB],
        activeId: wsA.id,
        expanded: true,
        attentionByWorkspace: { [wsB.id]: 4 },
      },
      global,
    });
    const badge = w.findAll('.wschip')[1]!.find('.badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('4');
  });
});
