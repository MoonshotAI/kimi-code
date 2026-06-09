// apps/kimi-web/src/components/__tests__/ChatPane.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import i18n from '../../i18n';
import ChatPane from '../ChatPane.vue';
import type { ChatTurn, ApprovalBlock } from '../../types';

// ChatPane (and child components) use vue-i18n; default locale is English.
const global = { plugins: [i18n] };

// Markdown (markstream-vue) renders async, so message text appears after a few
// frames. Poll until it settles before asserting on rendered prose.
async function settle(rounds = 80, step = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, step));
    await nextTick();
  }
}

const turns: ChatTurn[] = [
  { id: 't1', role: 'user', no: 1, text: '你好' },
  {
    id: 't2', role: 'assistant', no: 2, text: '执行中',
    tools: [{ id: 'x', name: 'read', arg: '· a.ts', status: 'ok', timing: '5ms' }],
  },
];

const approvals: { approvalId: string; block: ApprovalBlock }[] = [
  { approvalId: 'apr_1', block: { kind: 'diff', path: 'a.ts', diff: [{ kind: 'add', gutter: '1', text: '+ x' }] } },
];

describe('ChatPane', () => {
  it('渲染用户与助手发言、工具卡', async () => {
    const w = mount(ChatPane, { props: { turns }, global });
    await settle();
    expect(w.text()).toContain('你好');
    expect(w.text()).toContain('执行中');
    expect(w.findComponent({ name: 'ToolCall' }).exists()).toBe(true);
  });

  it('渲染待批准的独立 interrupt 卡片', () => {
    const w = mount(ChatPane, { props: { turns, approvals }, global });
    expect(w.findComponent({ name: 'ApprovalCard' }).exists()).toBe(true);
  });

  it('mobile=true：用户发言渲染为右侧气泡 .u-bub，助手发言无角色名标签', async () => {
    const w = mount(ChatPane, { props: { turns, mobile: true }, global });
    await settle();

    // The mobile bubble container, not the desktop line-turn layout.
    expect(w.find('.chat').exists()).toBe(true);
    expect(w.find('.ln').exists()).toBe(false);

    // User turn → a right-aligned bubble carrying the user text.
    const bubbles = w.findAll('.u-bub');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.text()).toContain('你好');

    // Assistant turn → left-aligned plain block, NO role/name label.
    const aMsg = w.find('.a-msg');
    expect(aMsg.exists()).toBe(true);
    expect(aMsg.text()).toContain('执行中');
    // No `kimi` / `kimi >` / `user@kimi` role prefix anywhere on mobile.
    expect(w.find('.role-row').exists()).toBe(false);
    expect(w.find('.pr').exists()).toBe(false);
    expect(w.text()).not.toContain('user@kimi');

    // Tool cards still render (ToolCall reused, in mobile mode).
    expect(w.findComponent({ name: 'ToolCall' }).exists()).toBe(true);
  });

  it('bubble=true（Modern 桌面，非 mobile）：用户发言渲染为 .u-bub 气泡，无终端行布局', async () => {
    // Modern desktop: bubble layout WITHOUT the phone shell (mobile stays false).
    const w = mount(ChatPane, { props: { turns, bubble: true, mobile: false }, global });
    await settle();

    expect(w.find('.chat').exists()).toBe(true);
    expect(w.find('.ln').exists()).toBe(false);

    const bubbles = w.findAll('.u-bub');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.text()).toContain('你好');

    // Assistant turn has no role label even on desktop Modern.
    expect(w.find('.role-row').exists()).toBe(false);
    expect(w.text()).not.toContain('user@kimi');
    // Tool cards still render in the bubble layout.
    expect(w.findComponent({ name: 'ToolCall' }).exists()).toBe(true);
  });

  it('默认（terminal，无 bubble/mobile）：渲染终端行布局 .ln，不是气泡', async () => {
    const w = mount(ChatPane, { props: { turns }, global });
    await settle();
    expect(w.find('.term').exists()).toBe(true);
    expect(w.find('.ln').exists()).toBe(true);
    expect(w.find('.chat').exists()).toBe(false);
    expect(w.find('.u-bub').exists()).toBe(false);
  });

  it('mobile=true：助手思考块用灰色 Codex 样式（.mthink，无引用条）', () => {
    const thinkingTurns: ChatTurn[] = [
      { id: 'a1', role: 'assistant', no: 1, text: '好的', thinking: '先看现有实现' },
    ];
    const w = mount(ChatPane, { props: { turns: thinkingTurns, mobile: true }, global });
    const think = w.find('.mthink');
    expect(think.exists()).toBe(true);
    // Codex style defaults to open and shows the thinking text.
    expect(think.classes()).toContain('open');
    expect(think.text()).toContain('先看现有实现');
  });
});
