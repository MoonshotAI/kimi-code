import { createApp, h, ref } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon } from '@moonshot-ai/app-client/icons';
import { createPinia } from 'pinia';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { pendingPromptTurn } from '@moonshot-ai/app-core/client';
import { setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { useTurnFolding, useAppDialogs } from '@moonshot-ai/app-client/composables';
import ConversationPane from '../../../src/renderer/components/chat/ConversationPane.vue';
import { turns, tasks, sessionId, status, setOlderPages, loads } from './client.mjs';
import '../../../src/renderer/style.css';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const shown = ref(false);
const i18n = createKimiI18n({ locale: 'zh' });
setKimiClientDeps({ t: i18n.global.t, api: () => ({ listTurnFileChanges: async () => [], getFileUrl: value => value }) });
useTurnFolding().setTurnFolding(true);
useAppDialogs().completeOnboarding();
document.documentElement.style.height = '100%';
document.body.style.cssText = 'height:100%;margin:0';
const host = document.querySelector('#app');
host.style.cssText = 'height:100vh;display:flex;width:1100px';
const app = createApp({ setup: () => () => shown.value ? h(ConversationPane, { sessionId: sessionId.value, status, mobile: false, working: false, style: 'height:100%;width:100%' }) : null });
app.provide(IconResolverKey, name => getIcon(name)?.component);
app.use(createPinia());
app.use(i18n);
app.mount('#app');

const loopErrors = [];
window.addEventListener('error', event => { if (String(event.message).includes('ResizeObserver')) loopErrors.push(event.message); });

const paragraph = (i, j) => `段落 ${i}.${j}：它们是客户端与服务端之间同一条 WebSocket 连接上的两类订阅，分别用于传输不同粒度的数据；服务端将连接关联到会话的事件广播器，从游标重新发送遗漏的事件，然后持续推送实时事件，用于驱动聊天区里的消息气泡、助手回复流式输出、工具调用卡片和 thinking 块的渲染。`;
const table = i => `| 字段名称 ${i} | 数据类型 | 字段说明文字 | 示例取值 |\n| --- | --- | --- | --- |\n${Array.from({ length: 4 }, (_, r) => `| session_id_${r} | string | 会话的唯一标识符号 | sess_0123456789_${r} |`).join('\n')}`;
const wideTable = `| 事件名称 | 触发时机 | 负载字段 | 消费方 | 说明 | 备注 | 版本 | 示例 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${Array.from({ length: 3 }, (_, r) => `| transcript.ops_${r} | 每次增量更新 | turn_id, step_id, frame | 聊天区消息气泡 | 助手回复流式输出 | 与 v1 事件互不干扰 | subscribe_v2 | {main:'delta'} |`).join('\n')}`;

function history(count, start = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const i = start + offset;
    if (i % 2 === 0) {
      return pendingPromptTurn({ id: `turn-${i}`, sessionId: sessionId.value, role: 'user', content: [{ type: 'text', text: `问题 ${i}：subscribe 和 subscribe_v2 是啥` }], createdAt: '2026-01-01T00:00:00.000Z' }, Math.floor(i / 2) + 1, { sessionId: sessionId.value });
    }
    const text = [
      `## 回复 ${i}`,
      paragraph(i, 0),
      paragraph(i, 1),
      `- 客户端发送：{ type: 'subscribe', id, payload: { session_ids, cursors, agent_filter } }，服务端从游标重新发送遗漏的事件。\n- 用途：驱动「请求中…」指示灯、composer 的队列模式、任务卡片、权限确认弹窗、会话列表的状态徽章等。\n- 服务端持续推送 transcript.reset（快照初始化）和 transcript.ops（增量操作）。`,
      table(i),
      ...(i === count - 5 ? [wideTable] : []),
      paragraph(i, 2),
      `END_${i}`,
    ].join('\n\n');
    return { id: `turn-${i}`, sessionId: sessionId.value, role: 'assistant', no: Math.floor(i / 2) + 1, text };
  });
}

const pane = () => document.querySelector('.panes');
const dock = () => document.querySelector('.chat-dock');
const distance = () => pane().scrollHeight - pane().scrollTop - pane().clientHeight;
const paneTop = () => pane().getBoundingClientRect().top;
async function until(check, label, timeout = 20000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
  await frame();
  await frame();
}

function tableMismatches() {
  let n = 0;
  for (const wrapper of pane().querySelectorAll('.table-node-wrapper')) {
    if (!wrapper.classList.contains('md-code-scroll-viewport')) continue;
    const overflows = wrapper.scrollWidth > wrapper.clientWidth + 1;
    if (overflows !== wrapper.classList.contains('md-table-scroll-overflow')) n++;
  }
  return n;
}

function runFrames(count, step, sample) {
  return new Promise(resolve => {
    const samples = [];
    let i = 0;
    const tick = () => {
      samples.push({ ...sample(), mismatches: tableMismatches() });
      if (i === count + 1) { resolve(samples); return; }
      const index = i++;
      if (index < count) setTimeout(() => requestAnimationFrame(() => step(index)), 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function flashes(values, min = 3) {
  const d = values.slice(1).map((v, i) => Math.round((v - values[i]) * 100) / 100);
  const at = [];
  for (let i = 0; i + 1 < d.length; i++) {
    if (Math.abs(d[i]) >= min && Math.abs(d[i + 1]) >= min && Math.sign(d[i]) !== Math.sign(d[i + 1]) && Math.abs(d[i] + d[i + 1]) <= Math.max(2, Math.abs(d[i]) * 0.35)) at.push({ frame: i, delta: d[i], back: d[i + 1] });
  }
  return { count: at.length, at: at.slice(0, 8), maxStep: Math.max(0, ...d.map(Math.abs)) };
}

function widthPlan(from, to, stepPx, pause) {
  const plan = [];
  const dir = Math.sign(to - from);
  for (let w = from; dir > 0 ? w <= to : w >= to; w += dir * stepPx) plan.push(w);
  for (let i = 0; i < pause; i++) plan.push(to);
  for (let w = to; dir > 0 ? w >= from : w <= from; w -= dir * stepPx) plan.push(w);
  for (let i = 0; i < pause; i++) plan.push(from);
  return plan;
}

async function resetWidth(width = 1100) {
  host.style.width = `${width}px`;
  await sleep(300);
  await frame();
  await frame();
}

async function detachTo(fraction) {
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  pane().scrollTop = Math.round((pane().scrollHeight - pane().clientHeight) * fraction);
  await sleep(700);
  await frame();
  await frame();
}

async function attachBottom() {
  pane().scrollTop = pane().scrollHeight;
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
  await sleep(700);
  await frame();
  await frame();
}

function referenceBelow(offset) {
  const top = paneTop();
  return [...pane().querySelectorAll('.md p, .md li')].find(el => el.getBoundingClientRect().top >= top + offset);
}

window.setup = async (count = 16) => {
  turns.value = history(count);
  shown.value = true;
  await until(() => document.querySelector(`[data-turn-id="turn-${count - 1}"]`)?.textContent.includes(`END_${count - 1}`) && distance() < 2, 'initial tail');
  await sleep(1200);
  return { count, windowed: !!document.querySelector('.history-window'), rows: pane().querySelectorAll('.history-row').length, tables: pane().querySelectorAll('.table-node-wrapper').length };
};

window.resizeMiddle = async () => {
  await resetWidth();
  await detachTo(0.45);
  const ref = referenceBelow(140);
  const plan = widthPlan(900, 540, 3, 8);
  const samples = await runFrames(plan.length, i => { host.style.width = `${plan[i]}px`; }, () => ({ top: ref.getBoundingClientRect().top - paneTop() }));
  await resetWidth();
  return { frames: plan.length, reference: ref.textContent.slice(0, 16), flashes: flashes(samples.map(s => s.top)), drift: Math.round((samples.at(-1).top - samples[0].top) * 100) / 100, tableMismatchFrames: samples.filter(s => s.mismatches).length };
};

const lastBody = () => [...pane().querySelectorAll('.md')].at(-1);
const tail = () => pane().getBoundingClientRect().bottom - lastBody().getBoundingClientRect().bottom;
const range = values => Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100;

window.resizeBottom = async () => {
  await resetWidth();
  await attachBottom();
  const plan = widthPlan(900, 540, 3, 8);
  const samples = await runFrames(plan.length, i => { host.style.width = `${plan[i]}px`; }, () => ({ distance: distance(), tail: tail() }));
  await resetWidth();
  const off = samples.filter(s => s.distance > 1);
  return { frames: plan.length, offBottomFrames: off.length, maxOffBottom: Math.max(0, ...samples.map(s => s.distance)), tailShift: range(samples.map(s => s.tail)), tableMismatchFrames: samples.filter(s => s.mismatches).length };
};

window.streamBottom = async () => {
  await resetWidth();
  await attachBottom();
  const index = turns.value.length - 1;
  const original = turns.value[index];
  const samples = await runFrames(40, i => {
    const current = turns.value[index];
    turns.value = [...turns.value.slice(0, index), { ...current, text: `${current.text}\n\n${paragraph(index, 100 + i)}` }];
  }, () => ({ distance: distance(), tail: tail() }));
  turns.value = [...turns.value.slice(0, index), original];
  await sleep(600);
  return { frames: 40, offBottomFrames: samples.filter(s => s.distance > 1).length, maxOffBottom: Math.max(0, ...samples.map(s => s.distance)), tailShift: range(samples.map(s => s.tail)) };
};

window.rowShrinkMiddle = async () => {
  await resetWidth();
  await detachTo(0.6);
  const top = paneTop();
  const above = [...pane().querySelectorAll('.md')].filter(el => el.getBoundingClientRect().bottom < top - 80);
  const turnEl = above.at(-1).closest('[data-turn-id]');
  const index = turns.value.findIndex(turn => turn.id === turnEl?.dataset.turnId);
  const ref = referenceBelow(140);
  const original = turns.value[index];
  const errors = loopErrors.length;
  const samples = await runFrames(30, i => {
    if (i === 0) turns.value = turns.value.map((turn, j) => j === index ? { ...turn, text: `## 回复 ${index}\n\n短回复。\n\nEND_${index}` } : turn);
  }, () => ({ top: ref.getBoundingClientRect().top - paneTop() }));
  turns.value = turns.value.map((turn, j) => j === index ? original : turn);
  await sleep(600);
  return { index, shrunkTurn: turnEl?.dataset.turnId, referenceShift: range(samples.map(s => s.top)), flashes: flashes(samples.map(s => s.top)), loopErrorsDuring: loopErrors.length - errors };
};

window.tableWide = async () => {
  await resetWidth();
  const wrapper = [...pane().querySelectorAll('.table-node-wrapper')].find(el => el.textContent.includes('transcript.ops_0'));
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  pane().scrollTop += wrapper.getBoundingClientRect().top - paneTop() - 120;
  await sleep(700);
  await frame();
  await frame();
  const toggle = wrapper.nextElementSibling?.querySelector('button.md-table-toggle');
  const ref = referenceBelow(wrapper.getBoundingClientRect().bottom - paneTop() + 10);
  const errors = loopErrors.length;
  const states = [];
  const samples = await runFrames(60, i => {
    if (i === 0 || i === 30) toggle.click();
  }, () => {
    states.push(wrapper.classList.contains('md-table-wide'));
    return { top: ref.getBoundingClientRect().top - paneTop() };
  });
  return { overflowsBefore: wrapper.scrollWidth > wrapper.clientWidth + 1, toggledWide: states.includes(true), backToNormal: !states.at(-1), flashes: flashes(samples.map(s => s.top)), tableMismatchFrames: samples.filter(s => s.mismatches).length, loopErrorsDuring: loopErrors.length - errors };
};

window.tableCrossing = async () => {
  await resetWidth();
  const wrappers = [...pane().querySelectorAll('.table-node-wrapper')].filter(el => !el.textContent.includes('transcript.ops_0'));
  const wrapper = wrappers[Math.floor(wrappers.length / 2)];
  const tableEl = wrapper.querySelector('table');
  tableEl.style.minWidth = '0';
  const natural = tableEl.getBoundingClientRect().width;
  tableEl.style.minWidth = '';
  const column = wrapper.clientWidth;
  const row = wrapper.closest('.history-row') ?? wrapper.closest('[data-turn-id]');
  const next = row?.nextElementSibling?.nextElementSibling ?? row?.nextElementSibling;
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  const target = next ?? row;
  pane().scrollTop += target.getBoundingClientRect().top - paneTop() + 40;
  await sleep(700);
  await frame();
  await frame();
  const ref = referenceBelow(100);
  let low = 300;
  let high = 1100;
  while (high - low > 1) {
    const mid = Math.round((low + high) / 2);
    host.style.width = `${mid}px`;
    if (wrapper.clientWidth >= natural) high = mid; else low = mid;
  }
  host.style.width = '1100px';
  await sleep(300);
  await frame();
  await frame();
  const widthAtNatural = high;
  const plan = widthPlan(Math.round(widthAtNatural + 40), Math.round(widthAtNatural - 40), 2, 8);
  const samples = await runFrames(plan.length, i => { host.style.width = `${plan[i]}px`; }, () => ({ top: ref.getBoundingClientRect().top - paneTop() }));
  await resetWidth();
  return { natural, column, widthAtNatural, frames: plan.length, reference: ref.textContent.slice(0, 16), flashes: flashes(samples.map(s => s.top)), drift: Math.round((samples.at(-1).top - samples[0].top) * 100) / 100, tableMismatchFrames: samples.filter(s => s.mismatches).length };
};

async function toggleBash(where) {
  await resetWidth();
  tasks.value = Array.from({ length: 5 }, (_, i) => ({ id: `bash-${i}`, name: `cd kimi-code && pnpm install > /tmp/kimi-install-${i}.log`, kind: 'bash', state: 'done', timing: '1 分 58 秒', runInBackground: true }));
  await until(() => document.querySelector('[data-pill="bash"]'), 'bash pill');
  if (where === 'bottom') await attachBottom();
  else await detachTo(0.45);
  const bashPill = document.querySelector('[data-pill="bash"]');
  const last = [...pane().querySelectorAll('[data-turn-id]')].at(-1);
  const ref = where === 'bottom' ? last : referenceBelow(140);
  let openGeometry = null;
  const samples = await runFrames(70, i => {
    if (i === 0 || i === 34) bashPill.click();
    if (i === 30) {
      const panel = document.querySelector('.dock-work-panel').getBoundingClientRect();
      const pill = bashPill.getBoundingClientRect();
      openGeometry = { panelTop: panel.top, panelBottom: panel.bottom, pillTop: pill.top, gap: pill.top - panel.bottom, dockTop: dock().getBoundingClientRect().top };
    }
  }, () => {
    const jump = document.querySelector('.newmsg-pill');
    return { content: (where === 'bottom' ? ref.getBoundingClientRect().bottom : ref.getBoundingClientRect().top) - paneTop(), dock: dock().offsetHeight, jump: jump ? jump.getBoundingClientRect().top : null, open: !!document.querySelector('.dock-work-panel') };
  });
  tasks.value = [];
  await sleep(300);
  const content = samples.map(s => s.content);
  const jumps = samples.map(s => s.jump).filter(v => v !== null);
  const docks = samples.map(s => s.dock);
  return {
    where,
    contentShift: Math.round((Math.max(...content) - Math.min(...content)) * 100) / 100,
    dockHeights: [...new Set(docks)],
    jumpPillShift: jumps.length ? Math.round((Math.max(...jumps) - Math.min(...jumps)) * 100) / 100 : null,
    openFrames: samples.filter(s => s.open).length,
    openGeometry,
  };
}

window.scrollUpHistory = async () => {
  await resetWidth();
  await attachBottom();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  await frame();
  const swipe = [12, 28, 48, 64, 72, 72, 64, 52, 40, 30, 20, 12, 6, 3];
  const plan = [];
  for (let i = 0; i < 6; i++) plan.push(...swipe, ...new Array(12).fill(0));
  let ref = null;
  let refTop = 0;
  const pick = () => {
    const top = paneTop();
    ref = [...pane().querySelectorAll('.turn-anchor[data-turn-id]')].find(el => el.getBoundingClientRect().bottom > top + 40 && el.getBoundingClientRect().top < top + pane().clientHeight) ?? null;
    refTop = ref ? ref.getBoundingClientRect().top - top : 0;
  };
  pick();
  const errors = loopErrors.length;
  const deviations = [0];
  let mounted = 0;
  let sampled = 0;
  for (let i = 0; i < plan.length; i++) {
    await frame();
    if (!ref?.isConnected) {
      pick();
      deviations.push(deviations.at(-1));
    } else {
      const top = ref.getBoundingClientRect().top - paneTop();
      deviations.push(deviations.at(-1) + (top - refTop) - (plan[i - 1] ?? 0));
      refTop = top;
      sampled++;
    }
    if (plan[i]) pane().scrollTop -= plan[i];
    mounted = Math.max(mounted, pane().querySelectorAll('.history-row').length);
  }
  await sleep(300);
  return { frames: plan.length, sampled, scrolled: plan.reduce((sum, step) => sum + step, 0), mountedRows: mounted, flashes: flashes(deviations), loopErrorsDuring: loopErrors.length - errors };
};

async function trackReference(plan, onFrame) {
  let ref = null;
  let refTop = 0;
  const pick = () => {
    const top = paneTop();
    ref = [...pane().querySelectorAll('.turn-anchor[data-turn-id]')].find(el => el.getBoundingClientRect().bottom > top + 40 && el.getBoundingClientRect().top < top + pane().clientHeight) ?? null;
    refTop = ref ? ref.getBoundingClientRect().top - top : 0;
  };
  pick();
  const deviations = [0];
  const refs = [];
  let sampled = 0;
  let applied = 0;
  for (let i = 0; i < plan.length; i++) {
    await frame();
    if (!ref?.isConnected) {
      pick();
      deviations.push(deviations.at(-1));
      refs.push(ref ? `${ref.dataset.turnId}@${Math.round(ref.getBoundingClientRect().top - paneTop())}` : 'none');
    } else {
      const rect = ref.getBoundingClientRect();
      const top = rect.top - paneTop();
      deviations.push(deviations.at(-1) + (top - refTop) - applied);
      refTop = top;
      sampled++;
      refs.push(`${ref.dataset.turnId}@${Math.round(top)}`);
      if (rect.bottom < paneTop() + 40 || top > pane().clientHeight) pick();
    }
    applied = 0;
    if (plan[i]) {
      const before = pane().scrollTop;
      pane().scrollTop -= plan[i];
      applied = before - pane().scrollTop;
    }
    onFrame?.(i);
  }
  return { deviations, sampled, refs };
}

window.loadOlderWhileScrolling = () => loadOlder(2);
window.loadLastPageWhileScrolling = () => loadOlder(1);
async function loadOlder(pages) {
  await resetWidth();
  setOlderPages([history(20, -20), history(20, -40)].slice(0, pages));
  await attachBottom();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  pane().scrollTop = Math.round(pane().clientHeight * 2.5);
  await sleep(900);
  await frame();
  await frame();
  const swipe = [12, 28, 48, 64, 72, 72, 64, 52, 40, 30, 20, 12, 6, 3];
  const plan = [];
  for (let i = 0; i < 10; i++) plan.push(...swipe, ...new Array(6).fill(0));
  plan.push(...new Array(60).fill(0));
  const errors = loopErrors.length;
  const { deviations, sampled } = await trackReference(plan);
  await sleep(300);
  const seen = loads.splice(0);
  setOlderPages([]);
  return { frames: plan.length, sampled, loads: seen.filter(l => l.kind === 'end').length, turns: turns.value.length, flashes: flashes(deviations), finalDeviation: Math.round(deviations.at(-1) * 10) / 10, loopErrorsDuring: loopErrors.length - errors };
}

window.randomEvents = async (seed = 7, frames = 600) => {
  await resetWidth();
  let pageNo = 0;
  const page = () => history(20, -1000 - 20 * ++pageNo);
  setOlderPages([page(), page(), page()]);
  await attachBottom();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  pane().scrollTop = Math.round(pane().clientHeight * 3);
  await sleep(900);
  await frame();
  await frame();
  let state = seed;
  const rnd = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const swipe = [12, 28, 48, 64, 72, 72, 64, 52, 40, 30, 20, 12, 6, 3];
  const plan = new Array(frames).fill(0);
  for (let i = 0; i < frames; i++) {
    if (plan[i] || rnd() > 0.06) continue;
    const sign = rnd() < 0.7 ? 1 : -1;
    swipe.forEach((step, j) => { if (i + j < frames) plan[i + j] = sign * step; });
  }
  const counts = { growAbove: 0, shrinkAbove: 0, growBelow: 0, shrinkBelow: 0, sentinel: 0, height: 0, width: 0 };
  const anchors = () => [...pane().querySelectorAll('.turn-anchor[data-turn-id]')];
  const pickTurn = above => {
    const top = paneTop();
    const bottom = top + pane().clientHeight;
    const list = anchors().filter(el => above ? el.getBoundingClientRect().bottom < top - 60 : el.getBoundingClientRect().top > bottom + 60);
    return list.length ? list[Math.floor(rnd() * list.length)].dataset.turnId : null;
  };
  const mutate = (id, grow) => {
    const index = turns.value.findIndex(turn => turn.id === id);
    if (index < 0 || turns.value[index].role !== 'assistant') return false;
    const el = document.querySelector(`.turn-anchor[data-turn-id="${id}"]`);
    lastMutation = `${id}#${index}@${Math.round(el.getBoundingClientRect().top - paneTop())}..${Math.round(el.getBoundingClientRect().bottom - paneTop())}`;
    turns.value = turns.value.map((turn, j) => j === index ? { ...turn, text: grow ? `${turn.text}\n\n${paragraph(index, 900 + counts.growAbove + counts.growBelow)}` : `## 回复 ${index}\n\n短回复。\n\nEND_${index}` } : turn);
    return true;
  };
  const errors = loopErrors.length;
  const events = [];
  let seenLoads = 0;
  let lastMutation = '';
  const { deviations, sampled, refs } = await trackReference(plan, i => {
    const loaded = loads.filter(l => l.kind === 'end').length;
    events[i] = loaded > seenLoads ? 'load' : '';
    seenLoads = loaded;
    const r = rnd();
    if (r < 0.55) return;
    if (r < 0.65) { if (mutate(pickTurn(true), true)) { counts.growAbove++; events[i] += `+growAbove(${lastMutation})`; } return; }
    if (r < 0.75) { if (mutate(pickTurn(true), false)) { counts.shrinkAbove++; events[i] += `+shrinkAbove(${lastMutation})`; } return; }
    if (r < 0.82) { if (mutate(pickTurn(false), true)) { counts.growBelow++; events[i] += `+growBelow(${lastMutation})`; } return; }
    if (r < 0.89) { if (mutate(pickTurn(false), false)) { counts.shrinkBelow++; events[i] += `+shrinkBelow(${lastMutation})`; } return; }
    if (r < 0.93) { setOlderPages(counts.sentinel % 2 ? [page()] : []); counts.sentinel++; events[i] += counts.sentinel % 2 ? '+sentinelOff' : '+sentinelOn'; return; }
    if (r < 0.97) { host.style.height = `${560 + Math.floor(rnd() * 340)}px`; counts.height++; events[i] += '+height'; return; }
    host.style.width = `${820 + Math.floor(rnd() * 280)}px`;
    counts.width++;
    events[i] += '+width';
  });
  host.style.height = '100vh';
  await resetWidth();
  const seen = loads.splice(0);
  setOlderPages([]);
  const steps = deviations.slice(1).map((value, j) => ({ frame: j, step: Math.round((value - deviations[j]) * 10) / 10, scroll: plan[j - 1] ?? 0, ref: refs.slice(Math.max(0, j - 2), j + 1), events: events.slice(Math.max(0, j - 3), j).filter(Boolean) })).filter(entry => Math.abs(entry.step) >= 10);
  return { seed, frames, sampled, counts, loads: seen.filter(l => l.kind === 'end').length, flashes: flashes(deviations), finalDeviation: Math.round(deviations.at(-1) * 10) / 10, steps: steps.slice(0, 20), loopErrorsDuring: loopErrors.length - errors };
};

window.bashBottom = () => toggleBash('bottom');
window.bashMiddle = () => toggleBash('middle');
window.loopErrors = () => loopErrors.slice();
