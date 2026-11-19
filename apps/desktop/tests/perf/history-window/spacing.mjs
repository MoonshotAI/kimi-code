import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon } from '@moonshot-ai/app-client/icons';
import { useActivityRunFolding, useTurnFolding } from '@moonshot-ai/app-client/composables';
import { ChatPane } from '@moonshot-ai/app-components';

export async function verifySpacing() {
  const folding = useTurnFolding();
  const activity = useActivityRunFolding();
  const savedFold = folding.turnFolding.value;
  const savedActivity = activity.activityRunFolding.value;
  const text = label => ({ kind: 'text', text: label });
  const thinking = { kind: 'thinking', thinking: 'Thinking', durationMs: 100 };
  const tool = id => ({ kind: 'tool', tool: { id, name: 'read', arg: 'file.txt', status: 'ok', output: ['Result'] } });
  const agent = { kind: 'tool', tool: { id: 'agent', name: 'task', arg: '{"description":"Read project files"}', status: 'ok', output: ['Done'] } };
  const notification = { kind: 'notification', notification: { id: 'notice', category: 'task', type: 'info', sourceKind: 'task', sourceId: 'task-1', title: 'Notice', severity: 'info', body: 'Task result', raw: '{}' } };
  const sequences = [
    [text('Only text')], [thinking, text('Final')], [tool('single'), text('Final')],
    [text('First'), tool('middle'), text('Final')],
    [thinking, tool('first'), tool('second'), text('Final')],
    [notification], [notification, text('Final')], [text('First'), notification],
    [text('First'), notification, text('Final')], [thinking, notification, text('Final')],
    [text(''), text('Final')], [text('First'), text(''), tool('after-empty'), text('Final')],
    [agent, text('Final')], [text('First'), agent, text('Final')], [thinking, agent, tool('after-agent'), text('Final')],
    [text('First'), agent],
  ];
  const turn = (blocks, i, extra = {}) => ({ id: `spacing-${i}`, sessionId: 'spacing', no: i + 1, role: 'assistant', text: '', blocks, ...extra });
  const mixed = sequences.flatMap((blocks, i) => [
    { id: `user-${i}`, sessionId: 'spacing', no: i + 1, role: 'user', text: `Question ${i}` },
    turn(blocks, i, { goalContinuation: i === 1 }),
  ]);
  const cases = [
    ...[true, false].flatMap(fold => sequences.map((_, i) => ({ name: `${fold ? 'folded' : 'unfolded'}-${i}`, turns: mixed.slice(i * 2, i * 2 + 2), fold }))),
    { name: 'streaming', turns: [turn([text('First'), tool('live'), text('Tail')], 0)], fold: true, working: true, turnActive: true },
    { name: 'load-earlier', turns: mixed.slice(0, 2), fold: false, hasMoreMessages: true },
    { name: 'first-notice', turns: [turn([notification, text('Final')], 0)], fold: false },
    { name: 'goal-notice', turns: [turn([notification, text('Final')], 0, { goalContinuation: true })], fold: false },
    { name: 'activity-heading', turns: [turn(sequences[4], 0)], fold: true, groupFold: true },
    { name: 'streaming-activity', turns: [turn([thinking, tool('a'), { ...tool('b'), tool: { ...tool('b').tool, status: 'running' } }], 0)], fold: true, groupFold: true, working: true, turnActive: true },
    { name: 'interrupted', turns: mixed.slice(0, 2), fold: true, interruptedTurnId: 'spacing-0' },
    { name: 'loading-assistant', turns: [turn([text('First')], 0)], fold: false, loadingMore: true },
    { name: 'compaction-cron', turns: [{ id: 'compact-first', role: 'compaction', text: 'Summary' }, ...mixed.slice(0, 2), { id: 'compact-later', role: 'compaction', text: 'Summary' }, { id: 'cron', role: 'cron', text: 'Reminder' }], fold: true },
    { name: 'empty-failed', turns: [], fold: true, turnFailed: true },
    { name: 'empty-working', turns: [], fold: true, working: true },
  ];
  const results = [];
  try {
    for (const { name, fold, groupFold = false, ...props } of cases) {
      folding.setTurnFolding(fold);
      activity.setActivityRunFolding(groupFold);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:flex-start;overflow:auto;background:var(--color-bg)';
      document.body.append(host);
      const app = createApp({ render: () => h('div', { style: 'display:flex;align-items:flex-start' }, [false, true].map(windowHistory => h('div', { class: 'panes', style: 'width:600px;flex:none' }, [h(ChatPane, { ...props, windowHistory, renderAllHistory: true })]))) });
      app.use(createPinia());
      app.use(createKimiI18n({ locale: 'en' }));
      app.provide(IconResolverKey, name => getIcon(name)?.component);
      app.mount(host);
      try {
        await nextTick();
        for (const head of host.querySelectorAll('.tf-head[aria-expanded="false"]')) head.click();
        await nextTick();
        for (const head of host.querySelectorAll('.ar-head[aria-expanded="false"]')) head.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        if (props.turns.some(turn => turn.blocks?.some(block => block.tool?.name === 'task')) && host.querySelectorAll('.agent-card').length !== 2) throw new Error(`Task cards missing: ${name}`);
        const selector = '.u-turn, .a-msg, .compact-divider, .cron-notice, .cn-head, .cn-bubble, .tf-head, .msg, .think, .tool-line, .tool-group, .agent-card, .activity-run, .ar-head, .ntf-list, .a-msg-ft, .goal-prov, .turn-failed, .sending-placeholder';
        const snapshots = [...host.querySelectorAll('.chat')].map(chat => {
          const origin = chat.getBoundingClientRect();
          return [...chat.querySelectorAll(selector)].map(el => {
            const rect = el.getBoundingClientRect();
            return { kind: [...el.classList].filter(name => !name.endsWith('-windowed')).join(' '), top: rect.top - origin.top, left: rect.left - origin.left, height: rect.height, width: rect.width };
          });
        });
        const [baseline, candidate] = snapshots;
        const differences = [];
        if (baseline.length !== candidate.length) differences.push({ count: [baseline.length, candidate.length] });
        baseline.forEach((before, i) => {
          const after = candidate[i];
          if (!after) return;
          const changed = Object.keys(before).filter(key => key === 'kind' ? before[key] !== after[key] : Math.abs(before[key] - after[key]) > 1);
          if (changed.length) differences.push({ index: i, kind: before.kind, changed, baseline: before, candidate: after });
        });
        results.push({ name, elements: baseline.length, differences });
      } finally {
        app.unmount();
        host.remove();
      }
    }
  } finally {
    folding.setTurnFolding(savedFold);
    activity.setActivityRunFolding(savedActivity);
  }
  return results;
}
