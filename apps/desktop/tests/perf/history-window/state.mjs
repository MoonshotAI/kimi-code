import { createApp, h, nextTick, ref } from 'vue';
import { createPinia } from 'pinia';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon } from '@moonshot-ai/app-client/icons';
import { useActivityRunFolding } from '@moonshot-ai/app-client/composables';
import HistoryWindow from '../../../../../packages/app-components/src/chat/HistoryWindow.vue';
import NotificationCard from '../../../../../packages/app-components/src/chat/NotificationCard.vue';
import ToolCall from '../../../../../packages/app-components/src/chat/ToolCall.vue';
import ActivityRun from '../../../../../packages/app-components/src/chat/ActivityRun.vue';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, message) { if (!value) throw new Error(message); }

export async function verifyHistoryState() {
  const folding = useActivityRunFolding();
  const savedFolding = folding.activityRunFolding.value;
  folding.setActivityRunFolding(true);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:var(--color-bg);z-index:9999';
  document.body.append(host);
  const windowRef = ref(null);
  const running = ref(true);
  const items = Array.from({ length: 100 }, (_, id) => ({ id: String(id) }));
  const notice = { id: 'notice', category: 'task', type: 'info', sourceKind: 'task', sourceId: 'task-1', title: 'Notice', severity: 'info', body: 'Result', raw: '{}' };
  const output = Array.from({ length: 100 }, (_, i) => `Output ${i}`);
  const tools = [
    { id: 'bash', name: 'bash', arg: '{"command":"echo test"}', status: 'ok', output, defaultExpanded: true },
    { id: 'generic', name: 'custom_tool', arg: '{}', status: 'ok', output, defaultExpanded: true },
    { id: 'read', name: 'read', arg: '{"path":"file.txt"}', status: 'ok', output: output.map((line, i) => `${i + 1}\t${line} ${'wide text '.repeat(50)}`), defaultExpanded: true },
  ];
  const app = createApp({ render: () => h('div', { class: 'panes state-pane', style: 'display:block;height:350px;width:700px;overflow:auto;position:relative' }, [
    h(HistoryWindow, { ref: windowRef, items, itemKey: item => item.id, enabled: true, scrollRoot: '.state-pane', estimate: () => 1000 }, {
      default: ({ item }) => h('div', { 'data-state-row': item.id, style: 'min-height:1000px' }, item.id === '10' ? [
        h(NotificationCard, { items: [notice] }),
        ...tools.map(tool => h(ToolCall, { key: tool.id, tool })),
        h(ActivityRun, { items: [{ kind: 'tool', sourceIndex: 0, tool: { id: 'activity-read', name: 'read', arg: 'file.txt', status: running.value ? 'running' : 'ok', output: ['done'] } }] }),
      ] : `Row ${item.id}`),
    }),
  ]) });
  app.use(createPinia());
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, name => getIcon(name)?.component);
  app.mount(host);
  const row = () => host.querySelector('[data-state-row="10"]');
  const surfaces = () => [...row().querySelectorAll('[data-scroll-anchor-id="bash"] .op, [data-scroll-anchor-id="generic"] .op, [data-scroll-anchor-id="read"] .hl-code')];
  const snapshot = () => ({
    details: Boolean(row().querySelector('.ntn .tool-line.open')),
    scroll: surfaces().map(el => [el.scrollTop, el.scrollLeft]),
    activity: row().querySelector('.ar-head').textContent.trim(),
  });
  const reveal = async id => { await windowRef.value.reveal(String(id)); await sleep(500); };
  try {
    await nextTick();
    await reveal(10);
    row().querySelector('.ntn .tl-head').click();
    await nextTick();
    const nodes = surfaces();
    assert(nodes.length === 3, 'Missing tool output or code surface');
    nodes.forEach((el, index) => { el.scrollTop = 80 + index * 40; });
    nodes[2].scrollLeft = 130;
    await sleep(1200);
    running.value = false;
    await sleep(300);
    const before = snapshot();
    assert(before.details && before.scroll.every(([top]) => top > 0) && before.scroll[2][1] > 0, 'State fixture did not expand and scroll');
    assert(/\d+s/.test(before.activity), 'Activity did not settle with a duration');
    for (let pass = 0; pass < 2; pass++) {
      await reveal(80);
      assert(!row(), 'State fixture did not unmount');
      await reveal(10);
      const after = snapshot();
      assert(JSON.stringify(after) === JSON.stringify(before), `State changed after remount: ${JSON.stringify({ before, after })}`);
    }
    return { before, after: snapshot(), remounts: 2 };
  } finally {
    app.unmount();
    host.remove();
    folding.setActivityRunFolding(savedFolding);
  }
}
