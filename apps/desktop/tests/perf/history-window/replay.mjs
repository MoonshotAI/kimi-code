import { createApp, h, nextTick, ref } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon } from '@moonshot-ai/app-client/icons';
import { createPinia } from 'pinia';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { ResolveImageKey } from '@moonshot-ai/app-core/contracts';
import { pendingPromptTurn } from '@moonshot-ai/app-core/client';
import { setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { useActivityRunFolding, useTurnFolding, useAppDialogs } from '@moonshot-ai/app-client/composables';
import ConversationPane from '../../../src/renderer/components/chat/ConversationPane.vue';
import { turns, sessionId, active, status, setOlder } from './client.mjs';
import '../../../src/renderer/style.css';
import { verifySpacing } from './spacing.mjs';
import { turnFileChanges } from './stability.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const shown = ref(false);
const mobile = ref(false);
let imageResolver = async src => src;
const i18n = createKimiI18n({ locale: 'en' });
setKimiClientDeps({ t: i18n.global.t, api: () => ({ listTurnFileChanges: async () => [], getTurnFileChanges: (session, turnId) => turnFileChanges(session, turnId), getFileUrl: value => value }) });
useTurnFolding().setTurnFolding(true);
useAppDialogs().completeOnboarding();
document.documentElement.style.height = '100%';
document.body.style.cssText = 'height:100%;margin:0';
document.querySelector('#app').style.cssText = 'height:100vh;display:flex';
const app = createApp({ setup: () => () => shown.value ? h(ConversationPane, { sessionId: sessionId.value, status, mobile: mobile.value, working: active.value, style: 'height:100%;width:100%' }) : null });
app.provide(IconResolverKey, name => getIcon(name)?.component);
app.provide(ResolveImageKey, src => imageResolver(src));
window.__setImageResolver = fn => { imageResolver = fn; globalThis.__resolveImageUrl = fn; };
app.use(createPinia());
app.use(i18n);
app.mount('#app');

window.verifySpacing = verifySpacing;

function history(start = 0, count = 240) {
  return Array.from({ length: count }, (_, offset) => {
    const i = start + offset;
    if (i % 2 === 0) {
      return pendingPromptTurn({ id: `turn-${i}`, sessionId: sessionId.value, role: 'user', content: [{ type: 'text', text: `Question ${i}` }], createdAt: '2026-01-01T00:00:00.000Z' }, Math.floor(i / 2) + 1, { sessionId: sessionId.value });
    }
    return {
      id: `turn-${i}`, sessionId: sessionId.value, role: i % 2 ? 'assistant' : 'user', no: Math.floor(i / 2) + 1,
      text: i % 2 ? `## Result ${i}\n\nA **searchable conclusion** MATCH_${i}.\n\n${Array.from({ length: 16 }, (_, j) => `Paragraph ${j}: The historical result remains readable after returning to this message.`).join('\n\n')}\n\n\`\`\`ts\n${Array.from({ length: 8 }, (_, j) => `const result_${i}_${j} = "${'horizontal-content '.repeat(12)}";`).join('\n')}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| sample | ${i} |\n\nEND_${i}` : `Question ${i}`,
      ...(i % 2 ? { thinking: 'Retained reasoning', tools: [{ id: `tool-${i}`, name: 'read', arg: `src/item_${i}.ts`, status: 'ok', output: ['Retained tool result'] }] } : {}),
    };
  });
}

const pane = () => document.querySelector('.panes');
const turn = id => document.querySelector(`[data-turn-id="turn-${id}"]`);
const body = id => turn(id)?.querySelector('.md');
const offset = id => turn(id).getBoundingClientRect().top - pane().getBoundingClientRect().top;
const distance = () => pane().scrollHeight - pane().scrollTop - pane().clientHeight;
function assert(value, message) { if (!value) throw new Error(message); }
async function until(check, label, timeout = 20000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
  await frame();
  await frame();
}
async function tocButton(id) {
  const scroller = document.querySelector('.toc-scroll');
  scroller.scrollTop = Math.floor(id / 2) * 25;
  const match = () => [...document.querySelectorAll('.toc-row')].find(el => el.textContent.trim() === `Question ${id}`);
  await until(match, `directory ${id}`);
  return match();
}
async function go(id) {
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  if (!turn(id)) {
    const target = await tocButton(id % 2 ? id - 1 : id);
    target?.click();
    await until(() => turn(id), `navigate ${id}`);
    await sleep(2200);
  }
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  assert(turn(id), `Navigation target ${id} disappeared`);
  turn(id).scrollIntoView({ block: 'start', behavior: 'instant' });
  await until(() => body(id)?.textContent.includes(`END_${id}`), `body ${id}`);
  await sleep(650);
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  assert(turn(id), `Navigation target ${id} disappeared`);
  turn(id).scrollIntoView({ block: 'start', behavior: 'instant' });
  await sleep(400);
}

window.replay = async (name, count = 240, steps = 80) => {
  mobile.value = name === 'mobile';
  turns.value = history(0, count);
  const started = performance.now();
  shown.value = true;
  await until(() => body(count - 1)?.textContent.includes(`END_${count - 1}`) && distance() < 2, 'initial tail');
  const openMs = performance.now() - started;
  await sleep(1400);
  const dom = pane().querySelectorAll('*').length;
  const mountedMessages = pane().querySelectorAll('.chat .turn-anchor[data-turn-id]').length;
  const suspended = pane().querySelectorAll('[data-md-suspended]').length;
  const mounted = pane().querySelectorAll('.markdown-renderer').length;
  const shadowDom = [...pane().querySelectorAll('*')].reduce((count, el) => count + (el.shadowRoot?.querySelectorAll('*').length ?? 0), 0);
  const frames = [];
  for (let step = 0; step < steps; step++) {
    const start = performance.now();
    if (step === 0) pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    pane().scrollTop -= 160;
    await frame();
    frames.push(performance.now() - start);
  }
  await sleep(400);
  frames.sort((a, b) => a - b);
  return { count, mountedMessages, scrollMessages: pane().querySelectorAll('.chat .turn-anchor[data-turn-id]').length, openMs, dom, pageDom: document.querySelectorAll('*').length, shadowDom, suspended, mounted, scrollDom: pane().querySelectorAll('*').length, frameP95Ms: frames[Math.floor(frames.length * .95)], frameMaxMs: frames.at(-1) };
};

window.verify = async () => {
  const windowed = !!document.querySelector('.history-window');
  await go(101);
  const head = turn(101).querySelector('.tf-head');
  head?.click();
  await sleep(350);
  const code = body(101).querySelector('.code-block-container');
  await until(() => code.querySelector('diffs-container')?.shadowRoot?.querySelector('pre[data-overflow]'), 'code enhancement');
  code.querySelector('.md-code-wrap-toggle').click();
  code.querySelector('.md-code-nums-toggle').click();
  await sleep(100);
  const before = offset(101);
  await sleep(700);
  const readingDrift = offset(101) - before;
  assert(Math.abs(readingDrift) < 3, `Reading drift ${readingDrift}`);
  await go(201);
  if (windowed) await until(() => !body(101), 'unload old body');
  const fontAnchor = windowed
    ? [...document.querySelector('.chat > .history-window').children].find(el => el.dataset.historyKey && el.getBoundingClientRect().bottom > pane().getBoundingClientRect().top)
    : turn(201);
  const fontBefore = fontAnchor.getBoundingClientRect().top - pane().getBoundingClientRect().top;
  document.documentElement.dataset.fontScale = 'xlarge';
  await sleep(500);
  assert(fontAnchor.isConnected, 'Font change unloaded the reading anchor');
  const fontReadingDrift = fontAnchor.getBoundingClientRect().top - pane().getBoundingClientRect().top - fontBefore;
  assert(Math.abs(fontReadingDrift) < 3, `Markdown font reading drift ${fontReadingDrift}`);

  assert(body(239)?.textContent.includes('END_239'), 'Tail unmounted');
  await go(101);
  assert(turn(101).querySelector('.tf-head')?.getAttribute('aria-expanded') === 'true', 'Fold state lost');
  await until(() => body(101).querySelector('.md-code-wrap-toggle')?.getAttribute('aria-pressed') === 'true', 'restored wrap');
  assert(body(101).querySelector('.md-code-nums-toggle')?.getAttribute('aria-pressed') === 'true', 'Line numbers lost');
  document.documentElement.dataset.fontScale = 'medium';
  await sleep(500);
  const restored = body(101).querySelector('.code-block-container');
  await until(() => restored.querySelector('diffs-container')?.shadowRoot?.querySelector('pre[data-overflow]'), 'restored enhancement');
  restored.querySelector('.md-code-wrap-toggle').click();
  await sleep(100);
  const surface = restored.querySelector('diffs-container').shadowRoot.querySelector('code[data-code]');
  surface.scrollLeft = 120;
  const scrollLeft = surface.scrollLeft;
  assert(scrollLeft > 0, 'Scroll fixture is not wide');
  await go(201);
  await go(101);
  await until(() => body(101).querySelector('diffs-container')?.shadowRoot?.querySelector('code[data-code]')?.scrollLeft === scrollLeft, 'restored code scroll');
  const button = body(101).querySelector('.md-code-nums-toggle');
  button.focus({ preventScroll: true });
  await go(201);
  assert(!!body(101), 'Focused body unloaded');
  button.blur();
  pane().scrollTop -= 1;
  if (windowed) await until(() => !body(101), 'released focus');
  await go(101);
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(body(101).querySelector('p'));
  selection.removeAllRanges();
  selection.addRange(range);
  await go(201);
  assert(!!body(101), 'Selected body unloaded');
  selection.removeAllRanges();
  if (windowed) await until(() => !body(101), 'released selection');
  await go(181);
  const searchTrigger = turn(181).querySelector('.tf-head');
  searchTrigger.focus({ preventScroll: true });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: false, bubbles: true }));
  await until(() => document.querySelector('.tsearch-input'), 'search open');
  const input = document.querySelector('.tsearch-input');
  input.value = 'searchable conclusion MATCH_21.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => document.querySelector('.tsearch-ring'), 'offscreen formatted search');
  await sleep(800);
  assert(body(21).textContent.includes('MATCH_21'), 'Search target missing');
  assert(Math.abs(offset(21)) < 1600, `Search wrong row ${offset(21)}`);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  assert(searchTrigger.isConnected && document.activeElement === searchTrigger, 'Search focus was not restored');
  searchTrigger.blur();
  const toc = await tocButton(160);
  toc.click();
  await sleep(1400);
  assert(Math.abs(offset(160) - pane().clientHeight / 2) < 100, `TOC drift ${offset(160)}`);
  const sessionBefore = offset(160);
  const sessionTurns = turns.value;
  sessionId.value = 'history-b';
  turns.value = history(300, 80);
  await until(() => body(379)?.textContent.includes('END_379') && distance() < 3, 'second session');
  sessionId.value = 'history-a';
  turns.value = sessionTurns;
  await until(() => turn(160), 'restored session');
  await sleep(2200);
  const sessionDrift = offset(160) - sessionBefore;
  assert(Math.abs(sessionDrift) < 3, `Session drift ${sessionDrift}`);
  await go(101);
  assert(turn(101).querySelector('.tf-head')?.getAttribute('aria-expanded') === 'true', 'Session switch lost fold state');
  await until(() => body(101).querySelector('.md-code-nums-toggle')?.getAttribute('aria-pressed') === 'true', 'session code state');
  await go(161);
  (await tocButton(160)).click();
  await sleep(1400);
  const widthBefore = offset(160);
  const historyRoot = turn(160).closest('.history-window') ?? document.querySelector('.chat');
  const contentWidth = historyRoot.clientWidth;
  document.querySelector('#app').style.width = '720px';
  await sleep(1100);
  assert(historyRoot.clientWidth < contentWidth, 'Reading-position fixture did not change content width');
  const widthDrift = offset(160) - widthBefore;
  assert(Math.abs(widthDrift) < 3, `Width drift ${widthDrift}`);
  document.querySelector('#app').style.width = '100%';
  await sleep(700);
  setOlder(history(-40, 40));
  await nextTick();
  const prependBefore = offset(160);
  document.querySelector('.top-sentinel-btn').click();
  await until(() => turns.value[0]?.id === 'turn--40', 'older messages');
  await sleep(800);
  const prependDrift = offset(160) - prependBefore;
  assert(Math.abs(prependDrift) < 3, `Prepend drift ${prependDrift}`);
  const pill = document.querySelector('.con .jump-pill');
  if (pill) pill.click();
  else {
    pane().scrollTop = pane().scrollHeight;
    await sleep(100);
  }
  await until(() => distance() < 3, 'return bottom');
  active.value = true;
  for (let i = 0; i < 10; i++) {
    turns.value = [...turns.value.slice(0, -1), { ...turns.value.at(-1), text: turns.value.at(-1).text + `\n\nStream update ${i}` }];
    await sleep(60);
  }
  active.value = false;
  await until(() => body(239)?.textContent.includes('Stream update 9'), 'streamed text');
  await until(() => distance() < 3, 'follow stream');
  const following = distance();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
  await until(() => document.getSelection()?.toString().includes('MATCH_1.') && document.getSelection()?.toString().includes('Stream update 9'), 'select all restored history');
  document.getSelection().removeAllRanges();
  await until(() => distance() < 3 && (!windowed || pane().querySelectorAll('.markdown-renderer').length < 20), 'leave select all');
  await sleep(250);
  return { windowed, readingDrift, fontReadingDrift, prependDrift, sessionDrift, widthDrift, focus: true, selection: true, codeScroll: true, selectAll: true, fold: true, wrap: true, numbers: true, search: true, searchFocus: true, toc: true, following };
};

window.verifyMobileHistory = async () => {
  mobile.value = true;
  shown.value = true;
  document.querySelector('#app').style.width = '390px';
  const mounted = () => pane().querySelectorAll('.chat .turn-anchor[data-turn-id]').length;
  const touchScroll = async top => {
    for (const [type, clientY] of [['touchstart', 100], ['touchmove', top < pane().scrollTop ? 160 : 40]]) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: [{ clientY }] });
      pane().dispatchEvent(event);
    }
    pane().scrollTop = top;
    pane().dispatchEvent(new Event('touchend', { bubbles: true }));
    await sleep(700);
  };
  const counts = [];
  for (const count of [20, 240]) {
    sessionId.value = `mobile-${count}`;
    turns.value = history(0, count);
    await until(() => body(count - 1)?.textContent.includes(`END_${count - 1}`) && distance() < 3, `mobile tail ${count}`);
    await sleep(600);
    assert(distance() < 3, `Mobile lost initial following ${count}: ${distance()}`);
    assert(mounted() < count, `Mobile mounted all ${count} messages`);
    assert([...pane().querySelectorAll('.markdown-renderer')].every(el => getComputedStyle(el).contentVisibility !== 'auto'), 'Mobile Markdown uses estimated layout');
    counts.push({ count, mounted: mounted() });
  }
  await touchScroll(0);
  await until(() => body(1)?.textContent.includes('END_1'), 'mobile head');
  turn(1).querySelector('.tf-head').click();
  turn(1).querySelector('.tf-head').blur();
  await sleep(300);
  await touchScroll(pane().scrollHeight);
  await until(() => !body(1), 'mobile unload');
  await touchScroll(0);
  await until(() => turn(1)?.querySelector('.tf-head')?.getAttribute('aria-expanded') === 'true', 'mobile fold restored');
  setOlder(history(-20, 20));
  await nextTick();
  document.querySelector('.top-sentinel-btn').click();
  await until(() => turns.value[0]?.id === 'turn--20', 'mobile older messages');
  await sleep(800);
  assert(mounted() < 40, `Mobile mounted all history after prepend: ${mounted()}`);
  document.activeElement?.blur();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
  await until(() => document.querySelector('.tsearch-input'), 'mobile search');
  const input = document.querySelector('.tsearch-input');
  input.value = 'searchable conclusion MATCH_201.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => document.querySelector('.tsearch-ring'), 'mobile offscreen search');
  await sleep(2200);
  assert(Math.abs(offset(201)) < 1600, `Mobile search missed target ${offset(201)}`);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(800);
  const savedTurns = turns.value;
  const savedOffset = offset(201);
  sessionId.value = 'mobile-other';
  turns.value = history(300, 80);
  await until(() => body(379)?.textContent.includes('END_379') && distance() < 3, 'mobile other session');
  sessionId.value = 'mobile-240';
  turns.value = savedTurns;
  await until(() => body(201)?.textContent.includes('END_201'), 'mobile session restored');
  await sleep(1500);
  const sessionDrift = offset(201) - savedOffset;
  assert(Math.abs(sessionDrift) < 3, `Mobile session drift ${sessionDrift}`);
  await touchScroll(pane().scrollHeight);
  await until(() => !body(201), 'touch releases restored message');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
  await until(() => document.getSelection()?.toString().includes('MATCH_1.') && document.getSelection()?.toString().includes('END_239'), 'mobile select all');
  document.getSelection().removeAllRanges();
  await until(() => mounted() < 20, 'mobile release selection');
  document.querySelector('.con .jump-pill')?.click();
  await until(() => distance() < 3, 'mobile return bottom');
  active.value = true;
  for (let i = 0; i < 5; i++) {
    turns.value = [...turns.value.slice(0, -1), { ...turns.value.at(-1), text: turns.value.at(-1).text + `\n\nMobile stream ${i}` }];
    await sleep(100);
  }
  active.value = false;
  await until(() => body(239)?.textContent.includes('Mobile stream 4') && distance() < 3, 'mobile stream following');
  mobile.value = false;
  document.querySelector('#app').style.width = '100%';
  return { counts, pagination: true, sessionDrift, fold: true, search: true, selectAll: true, touchRelease: true, following: true };
};

window.verifyGeometry = async () => {
  const results = [];
  for (const count of [24, 240]) {
    sessionId.value = `geometry-${count}`;
    turns.value = Array.from({ length: count }, (_, i) => ({
      id: `turn-${i}`, sessionId: sessionId.value, role: i === count - 1 ? 'cron' : i === 0 || i === 2 ? 'compaction' : 'user', text: `Question ${i}`,
    }));
    await until(() => turn(count - 1)?.classList.contains('cron-notice') && distance() < 3, 'cron session');
    const notice = turn(count - 1);
    const chat = document.querySelector('.chat');
    const historyRoot = chat.querySelector(':scope > .history-window') ?? chat;
    const rightGap = () => {
      const parent = notice.parentElement;
      return parent.getBoundingClientRect().right - parseFloat(getComputedStyle(parent).paddingRight) - notice.getBoundingClientRect().right;
    };
    const cronGap = rightGap();
    assert(Math.abs(cronGap) < 2, `Cron right alignment ${count}: ${cronGap}`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    await until(() => chat.querySelectorAll('[data-turn-id]').length === count, 'measure complete short-message history');
    await sleep(500);
    const contentTop = historyRoot.getBoundingClientRect().top + (historyRoot === chat ? parseFloat(getComputedStyle(chat).paddingTop) : 0);
    const previousRow = turn(1).closest('.history-row') ?? turn(1).closest('.u-turn');
    const compaction = {
      firstGap: turn(0).getBoundingClientRect().top - contentTop,
      laterGap: turn(2).getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom,
    };
    assert(Math.abs(compaction.firstGap) < 1, `First compaction gap ${count}: ${compaction.firstGap}`);
    assert(Math.abs(compaction.laterGap - parseFloat(getComputedStyle(chat).getPropertyValue('--chat-turn-gap'))) < 1, `Later compaction gap ${count}: ${compaction.laterGap}`);
    document.getSelection().removeAllRanges();
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    pane().scrollTop = pane().scrollHeight / 2;
    await sleep(500);
    if (count > 40 && historyRoot !== chat) assert(chat.querySelectorAll('[data-turn-id]').length < count / 2, 'Short messages were not unloaded');
    const widthBefore = historyRoot.clientWidth;
    const heightBefore = pane().scrollHeight;
    document.querySelector('#app').style.width = '720px';
    await sleep(700);
    const widthAfter = historyRoot.clientWidth;
    assert(widthAfter < widthBefore, `Resize fixture did not change content width: ${widthBefore} -> ${widthAfter}`);
    const resizeDrift = pane().scrollHeight - heightBefore;
    assert(Math.abs(resizeDrift) < 2, `Fixed-height history changed on resize: ${resizeDrift}`);
    assert(Math.abs(rightGap()) < 2, 'Cron right alignment changed on resize');
    document.querySelector('#app').style.width = '100%';
    await sleep(700);
    const restoreDrift = pane().scrollHeight - heightBefore;
    assert(Math.abs(restoreDrift) < 2, `History height changed after restoring width: ${restoreDrift}`);
    let viewport;
    if (count === 240) {
      const toc = document.querySelector('.toc-scroll');
      const originalStyle = toc.getAttribute('style');
      toc.style.height = '100px';
      toc.style.maxHeight = '100px';
      toc.style.flexShrink = '0';
      toc.scrollTop = 1000;
      await sleep(500);
      const before = { height: toc.clientHeight, scroll: toc.scrollTop, mounted: toc.querySelectorAll('.toc-row').length };
      let scrollEvents = 0;
      const onScroll = () => scrollEvents++;
      toc.addEventListener('scroll', onScroll);
      toc.style.height = '694px';
      toc.style.maxHeight = '694px';
      await sleep(500);
      toc.removeEventListener('scroll', onScroll);
      const bottom = Math.max(...[...toc.querySelectorAll('.toc-row')].map(el => el.getBoundingClientRect().bottom - toc.getBoundingClientRect().top).filter(value => value > 0 && value <= toc.clientHeight));
      viewport = { before, after: { height: toc.clientHeight, scroll: toc.scrollTop, mounted: toc.querySelectorAll('.toc-row').length }, blank: toc.clientHeight - bottom, scrollEvents };
      assert(toc.clientHeight > before.height + 500, 'Outline height did not grow');
      assert(scrollEvents === 0 && toc.scrollTop === before.scroll, 'Outline resize unexpectedly scrolled');
      assert(viewport.blank < 25, `Outline resize left blank space: ${viewport.blank}`);
      if (originalStyle === null) toc.removeAttribute('style');
      else toc.setAttribute('style', originalStyle);
    }
    results.push({ count, cronGap, compaction, widthBefore, widthAfter, resizeDrift, restoreDrift, viewport });
  }
  return results;
};

window.verifyImages = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  canvas.getContext('2d').fillRect(0, 0, 64, 48);
  const url = canvas.toDataURL('image/png');
  const image = () => body(121)?.querySelector('img');
  const visit = async () => {
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    const target = await tocButton(120);
    target.click();
    await until(() => turn(121), 'image message');
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    turn(121).scrollIntoView({ block: 'start', behavior: 'instant' });
    await sleep(300);
  };
  const leave = async () => {
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    pane().scrollTop = pane().scrollHeight;
    await until(() => !turn(121), 'unloaded image message');
  };
  const open = async (id, src) => {
    if (turn(121)) await leave();
    sessionId.value = id;
    turns.value = Array.from({ length: 240 }, (_, i) => ({
      id: `turn-${i}`, sessionId: id, role: i % 2 ? 'assistant' : 'user',
      text: i === 121 ? `![Local image](${src})\n\nImage result` : i % 2 ? `Result ${i}` : `Question ${i}`,
    }));
    await nextTick();
    await until(() => turn(239) && distance() < 3, 'image session');
    await visit();
  };
  let reads = 0;
  imageResolver = async () => { reads++; await sleep(150); return url; };
  await open('image-reuse', './image.png');
  await until(() => image()?.naturalWidth === 64, 'resolved image');
  const readCounts = [reads];
  for (let i = 0; i < 2; i++) {
    await leave();
    await visit();
    assert(image()?.src === url, 'Cached image returned to a placeholder');
    await until(() => image()?.naturalWidth === 64, 'cached image');
    readCounts.push(reads);
  }
  assert(readCounts[0] > 0 && readCounts.every(count => count === readCounts[0]), `Image resolution counts: ${readCounts.join(' -> ')}`);
  const readsBeforeEdit = reads;
  await leave();
  turns.value[121] = { ...turns.value[121], text: 'Updated result\n\n![Local image](./image.png)' };
  await visit();
  await until(() => image()?.naturalWidth === 64, 'updated image');
  assert(reads > readsBeforeEdit, 'Changed Markdown reused an old image snapshot');
  const readsBeforeSession = reads;
  canvas.width = 96;
  const otherUrl = canvas.toDataURL('image/png');
  imageResolver = async () => { reads++; await sleep(150); return otherUrl; };
  await open('image-other-session', './image.png');
  await until(() => image()?.naturalWidth === 96, 'other session image');
  assert(reads > readsBeforeSession && image()?.src === otherUrl, 'Image cache crossed session boundaries');
  const sessionReads = reads;
  await leave();
  await visit();
  assert(image()?.src === otherUrl && reads === sessionReads, 'Other session image was not reused');
  let failures = 0;
  imageResolver = async src => ++failures === 1 ? src : url;
  await open('image-retry', './history-image-retry.gif');
  await until(() => image()?.naturalWidth === 1, 'failed resolution fallback');
  await leave();
  await visit();
  await until(() => image()?.naturalWidth === 64, 'retried image');
  assert(failures === 2, 'Failed resolution was cached');
  let complete;
  let pendingReads = 0;
  imageResolver = () => { pendingReads++; return new Promise(resolve => { complete = resolve; }); };
  await open('image-pending', './image.png');
  await until(() => complete, 'pending image resolution');
  await leave();
  complete(url);
  await sleep(50);
  await visit();
  await until(() => image()?.naturalWidth === 64, 'late image completion');
  assert(pendingReads === 1, 'Completion after unmount was not reused');
  imageResolver = async src => src;
  return { resolutionCalls: readCounts, readsAfterContentAndSessionChanges: reads, failureAttempts: failures, pendingReads };
};

window.verifyLayout = async () => {
  sessionId.value = 'layout-state';
  turns.value = history(0, 42);
  turns.value[39] = { id: 'turn-39', sessionId: sessionId.value, role: 'assistant', text: 'Plain reply' };
  await until(() => body(41)?.textContent.includes('END_41'), 'layout session');
  const message = (id = 41) => (turn(id).querySelector(':scope > .history-window') ?? turn(id)).querySelector('.msg');
  const head = () => turn(41).querySelector('.tf-head');
  const code = () => message()?.querySelector('.code-block-container');
  const surface = () => code()?.querySelector('diffs-container')?.shadowRoot?.querySelector('code[data-code]');
  const state = () => ({
    fold: head().getAttribute('aria-expanded') === 'true',
    wrap: code().querySelector('.md-code-wrap-toggle').getAttribute('aria-pressed') === 'true',
    numbers: code().querySelector('.md-code-nums-toggle').getAttribute('aria-pressed') === 'true',
  });
  const layout = async (narrow) => {
    mobile.value = narrow;
    document.querySelector('#app').style.width = narrow ? '620px' : '100%';
    await until(() => document.querySelector(narrow ? '.con.mobile' : '.con:not(.mobile)') && surface(), 'layout code');
    await sleep(650);
  };
  await until(() => surface() && code().querySelector('.md-code-nums-toggle'), 'layout controls');
  await sleep(500);
  const gaps = {
    folded: message().getBoundingClientRect().top - head().closest('.turn-fold').getBoundingClientRect().bottom,
    plain: message(39).getBoundingClientRect().top - turn(39).getBoundingClientRect().top,
  };
  assert(Math.abs(gaps.folded) < 1, `Final reply gained a gap: ${gaps.folded}`);
  assert(Math.abs(gaps.plain) < 1, `Plain reply gained a gap: ${gaps.plain}`);
  head().click();
  code().querySelector('.md-code-wrap-toggle').click();
  code().querySelector('.md-code-nums-toggle').click();
  await sleep(350);
  const before = state();
  assert(Object.values(before).every(Boolean), 'Layout controls were not enabled');
  await layout(true);
  const narrow = state();
  assert(Object.values(narrow).every(Boolean), 'Narrow layout lost interaction state');
  assert(document.querySelector('.chat').querySelectorAll('[data-turn-id]').length < 42, 'Narrow layout mounted the full history');
  head().click();
  code().querySelector('.md-code-wrap-toggle').click();
  code().querySelector('.md-code-nums-toggle').click();
  await sleep(350);
  await layout(false);
  const restored = state();
  assert(Object.values(restored).every(value => !value), 'Wide layout lost changes made in narrow layout');
  surface().scrollLeft = 120;
  const scrollLeft = surface().scrollLeft;
  assert(scrollLeft > 0, 'Layout fixture did not scroll the code');
  await layout(true);
  assert(Math.abs(surface().scrollLeft - scrollLeft) < 1, 'Narrow layout lost code scrolling');
  await layout(false);
  assert(Math.abs(surface().scrollLeft - scrollLeft) < 1, 'Wide layout lost code scrolling');
  const mounted = document.querySelector('.chat').querySelectorAll('[data-turn-id]').length;
  if (document.querySelector('.chat > .history-window')) assert(mounted < 42, 'Wide layout did not resume history unloading');
  return { gaps, before, narrow, restored, scrollLeft, mounted };
};

window.verifyFontScale = async () => {
  sessionId.value = 'font-scale';
  turns.value = Array.from({ length: 240 }, (_, i) => ({
    id: `turn-${i}`, sessionId: sessionId.value, role: i === 239 ? 'cron' : 'user', text: `Question ${i}`,
  }));
  await until(() => turn(239)?.classList.contains('cron-notice') && distance() < 3, 'font session');
  const historyRoot = () => document.querySelector('.chat > .history-window');
  const measureAll = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    await until(() => historyRoot().querySelectorAll('[data-turn-id]').length === 240, 'all font rows');
    await sleep(600);
    const height = historyRoot().getBoundingClientRect().height;
    document.getSelection().removeAllRanges();
    await sleep(400);
    return height;
  };
  await measureAll();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  pane().scrollTop = pane().scrollHeight / 2;
  await sleep(500);
  const tocHeight = document.querySelector('.toc-scroll').scrollHeight;
  const results = [];
  for (const [scale, nearBottom] of [['xlarge', false], ['small', false], ['large', false], ['medium', false], ['xlarge', true], ['small', true]]) {
    if (nearBottom) {
      pane().scrollTop = pane().scrollHeight - pane().clientHeight - 200;
      await sleep(500);
    }
    const anchor = [...historyRoot().children].find(el => el.dataset.historyKey && el.getBoundingClientRect().bottom > pane().getBoundingClientRect().top);
    const before = anchor.getBoundingClientRect().top;
    document.documentElement.dataset.fontScale = scale;
    await sleep(800);
    const drift = anchor.getBoundingClientRect().top - before;
    const estimated = historyRoot().getBoundingClientRect().height;
    const mounted = historyRoot().querySelectorAll('[data-turn-id]').length;
    assert(mounted < 120, `Font change mounted the whole history: ${mounted}`);
    assert(Math.abs(drift) < 3, `Font reading drift ${scale}: ${drift}`);
    assert(Math.abs(document.querySelector('.toc-scroll').scrollHeight - tocHeight) < 2, 'Font change scaled fixed-height outline rows');
    const measured = await measureAll();
    const error = estimated - measured;
    assert(Math.abs(error) < measured * 0.01, `Stale font heights ${scale}: ${error}`);
    results.push({ scale, nearBottom, estimated, measured, error, drift, mounted });
  }
  const savedTurns = turns.value;
  sessionId.value = 'font-away';
  turns.value = history(300, 24);
  await until(() => body(323)?.textContent.includes('END_323'), 'font alternate session');
  document.documentElement.dataset.fontScale = 'large';
  await sleep(300);
  sessionId.value = 'font-scale';
  turns.value = savedTurns;
  await until(() => turn(239)?.classList.contains('cron-notice'), 'font saved session');
  await sleep(1000);
  const restored = historyRoot().getBoundingClientRect().height;
  const measured = await measureAll();
  assert(Math.abs(restored - measured) < measured * 0.01, `Saved session reused old font heights: ${restored - measured}`);
  document.documentElement.dataset.fontScale = 'medium';
  await sleep(700);
  return { scales: results, restoredError: restored - measured };
};

let scrollKeyProbe;
let scrollKeyTimer;
window.prepareScrollKey = async () => {
  if (sessionId.value !== 'scroll-keys') {
    sessionId.value = 'scroll-keys';
    turns.value = Array.from({ length: 240 }, (_, i) => ({ id: `turn-${i}`, sessionId: sessionId.value, role: 'user', text: `Question ${i}` }));
    await until(() => turn(239) && distance() < 3, 'scroll key session');
  }
  document.querySelector('.toc-scroll').scrollTop = 80 * 25;
  const target = () => [...document.querySelectorAll('.toc-row')].find(el => el.textContent.trim() === 'Question 80');
  await until(target, 'scroll key outline target');
  target().click();
  await sleep(650);
  turn(80).closest('[data-history-key]').focus({ preventScroll: true });
  scrollKeyProbe = { start: pane().scrollTop, samples: [] };
  scrollKeyTimer = setInterval(() => scrollKeyProbe.samples.push(pane().scrollTop), 25);
};
window.finishScrollKey = async direction => {
  await sleep(1000);
  clearInterval(scrollKeyTimer);
  const deltas = scrollKeyProbe.samples.map(top => (top - scrollKeyProbe.start) * direction);
  const peak = Math.max(...deltas);
  const end = deltas.at(-1);
  assert(peak > 60, `Native key did not scroll: ${peak}`);
  assert(end > peak * 0.8, `Keyboard scroll pulled back: ${peak} -> ${end}`);
  return { peak, end };
};

let restoreFollowFolding;
const followOutput = () => document.querySelector('[data-scroll-anchor-id="follow-output"] .op');
const followState = () => ({
  pill: !!document.querySelector('.con .jump-pill'),
  following: pane().classList.contains('is-following'),
  distance: Math.round(distance()),
  outputTop: followOutput()?.scrollTop ?? null,
});
function appendToTurn(id, paragraphs) {
  turns.value = turns.value.map(item => item.id === id ? { ...item, text: `${item.text}\n\n${paragraphs.join('\n\n')}` } : item);
}
window.prepareFollow = async () => {
  const turnFolding = useTurnFolding();
  const runFolding = useActivityRunFolding();
  const saved = [turnFolding.turnFolding.value, runFolding.activityRunFolding.value];
  restoreFollowFolding = () => {
    turnFolding.setTurnFolding(saved[0]);
    runFolding.setActivityRunFolding(saved[1]);
  };
  turnFolding.setTurnFolding(false);
  runFolding.setActivityRunFolding(false);
  sessionId.value = 'follow';
  const base = history(0, 40);
  turns.value = [...base.slice(0, -1), {
    ...base.at(-1), text: 'FOLLOW_DONE', thinking: undefined,
    tools: [{ id: 'follow-output', name: 'bash', arg: JSON.stringify({ command: 'seq 60' }), status: 'ok', output: Array.from({ length: 60 }, (_, i) => `FOLLOW_LINE_${i}`), defaultExpanded: true }],
  }];
  await until(() => body(39)?.textContent.includes('FOLLOW_DONE') && followOutput() && distance() < 2 && pane().classList.contains('is-following'), 'follow session');
  await sleep(800);
  const paneRect = pane().getBoundingClientRect();
  const outputRect = followOutput().getBoundingClientRect();
  const output = { x: Math.round(outputRect.left + outputRect.width / 2), y: Math.round(outputRect.top + Math.min(outputRect.height / 2, 60)) };
  const text = { x: Math.round(paneRect.left + 40), y: Math.round(paneRect.top + paneRect.height / 3) };
  assert(followOutput().scrollHeight > followOutput().clientHeight + 1 && followOutput().scrollTop === 0, 'Tool output does not overflow from its top');
  assert(followOutput().contains(document.elementFromPoint(output.x, output.y)), 'Tool output is not under the pointer');
  assert(pane().contains(document.elementFromPoint(text.x, text.y)) && !document.elementFromPoint(text.x, text.y).closest('.op'), 'Text point misses the transcript');
  return { text, output, viewport: pane().clientHeight };
};
window.followState = followState;
window.resetFollow = async () => {
  if (!pane().classList.contains('is-following')) {
    const pill = document.querySelector('.con .jump-pill');
    if (pill) pill.click();
    else pane().scrollTop = pane().scrollHeight;
  }
  await until(() => pane().classList.contains('is-following') && distance() < 2 && !document.querySelector('.con .jump-pill'), 'follow reset', 5000);
  document.activeElement?.blur();
  await sleep(300);
};
window.growFollow = async () => {
  appendToTurn('turn-39', Array.from({ length: 40 }, (_, i) => `Growth paragraph ${i}.`));
  await until(() => body(39)?.textContent.includes('Growth paragraph 39'), 'follow growth');
  await sleep(800);
  return followState();
};
window.growAboveFollow = async () => {
  const before = turn(39).getBoundingClientRect().top;
  appendToTurn('turn-35', Array.from({ length: 20 }, (_, i) => `Earlier growth ${i}.`));
  await until(() => body(35)?.textContent.includes('Earlier growth 19'), 'follow growth above');
  await sleep(800);
  return { ...followState(), drift: Math.round(turn(39).getBoundingClientRect().top - before) };
};
window.startFollowStream = async () => {
  active.value = true;
  await until(() => pane().classList.contains('is-following') && distance() < 2, 'follow stream start');
  await sleep(300);
};
window.streamFollow = async () => {
  const top = pane().scrollTop;
  for (let i = 0; i < 12; i++) {
    appendToTurn('turn-39', [`Streamed paragraph ${i}: ${'streaming text '.repeat(8)}`]);
    await sleep(80);
  }
  await until(() => body(39)?.textContent.includes('Streamed paragraph 11'), 'follow stream growth');
  await sleep(600);
  const state = { ...followState(), drift: Math.round(pane().scrollTop - top) };
  active.value = false;
  await sleep(300);
  return state;
};
window.streamSteadyFollow = async () => {
  active.value = true;
  await until(() => pane().classList.contains('is-following') && distance() < 2, 'steady stream start');
  let detached = 0;
  const watch = new MutationObserver(() => { if (!pane().classList.contains('is-following')) detached++; });
  watch.observe(pane(), { attributes: true, attributeFilter: ['class'] });
  for (let i = 0; i < 24; i++) {
    const block = i % 3 === 0
      ? `\`\`\`ts\n${Array.from({ length: 6 }, (_, j) => `const steady_${i}_${j} = ${j};`).join('\n')}\n\`\`\``
      : i % 3 === 1 ? `| Step | Value |\n| --- | --- |\n| ${i} | ${'cell '.repeat(6)} |` : `Steady paragraph ${i}: ${'streaming text '.repeat(10)}`;
    appendToTurn('turn-39', [block]);
    await sleep(60);
  }
  await until(() => body(39)?.textContent.includes('Steady paragraph 23'), 'steady stream growth');
  await sleep(800);
  watch.disconnect();
  const state = { ...followState(), detached };
  active.value = false;
  await sleep(300);
  return state;
};
let growthTicker = 0;
window.startGrowthTicker = async () => {
  active.value = true;
  let index = 0;
  growthTicker = setInterval(() => appendToTurn('turn-39', [`Ticker paragraph ${index++}: ${'streaming text '.repeat(6)}`]), 80);
  await sleep(300);
  const paneRect = pane().getBoundingClientRect();
  const target = [...body(39).querySelectorAll('p')].filter(p => {
    const rect = p.getBoundingClientRect();
    return rect.top > paneRect.top + 80 && rect.bottom < paneRect.bottom - 240;
  }).at(-1);
  assert(target, 'No paragraph to select from');
  const rect = target.getBoundingClientRect();
  const start = { x: Math.round(rect.left + 12), y: Math.round(rect.top + rect.height / 2) };
  assert(body(39).contains(document.elementFromPoint(start.x, start.y)), 'Selection start misses the reply');
  return { start, above: { x: start.x, y: Math.max(4, Math.round(paneRect.top - 24)) } };
};
window.stopGrowthTicker = async () => {
  clearInterval(growthTicker);
  active.value = false;
  document.getSelection()?.removeAllRanges();
  await sleep(300);
};
window.verifySettle = async () => {
  sessionId.value = 'follow-settle';
  turns.value = history(0, 240);
  const switched = performance.now();
  while (!turn(239)) await sleep(10);
  const veiled = pane().classList.contains('session-settling');
  const wheel = performance.now();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  while (pane().classList.contains('session-settling') && performance.now() - switched < 3000) await sleep(10);
  const lifted = performance.now();
  return { veiled, sinceSwitch: Math.round(lifted - switched), sinceWheel: Math.round(lifted - wheel) };
};
window.finishFollow = steps => {
  restoreFollowFolding?.();
  const failures = [];
  const check = (ok, label, step) => { if (!ok) failures.push(`${label} ${JSON.stringify(step)}`); };
  check(!steps.nudge.following && !steps.nudge.pill, 'A 40px nudge should stop following without the pill', steps.nudge);
  check(!steps.far.following && steps.far.pill, 'Scrolling far up should show the pill', steps.far);
  check(steps.back.following && !steps.back.pill && steps.back.distance < 2, 'Scrolling back down should resume following', steps.back);
  check(steps.pixel.following && !steps.pixel.pill, 'A 1px nudge and scroll back should resume following', steps.pixel);
  check(steps.output.following && !steps.output.pill && steps.output.distance < 2, 'Wheel over contained tool output should leave the transcript alone', steps.output);
  check(steps.endKey.following && !steps.endKey.pill, 'End at the bottom should keep following', steps.endKey);
  check(!steps.above.following && !steps.above.pill && Math.abs(steps.above.drift) <= 3, 'Growth above the viewport should keep the reading position without the pill', steps.above);
  check(!steps.detached.following && !steps.detached.pill, 'Scrolling up less than half a viewport should not show the pill', steps.detached);
  check(!steps.grown.following && steps.grown.pill, 'Growth past half a viewport should show the pill', steps.grown);
  check(!steps.streamDetached.following && !steps.streamDetached.pill, 'A small scroll during streaming should stop following', steps.streamDetached);
  check(!steps.streamed.following && Math.abs(steps.streamed.drift) <= 2 && steps.streamed.pill, 'Streaming below a detached reader should not move the view', steps.streamed);
  check(steps.settle.veiled && steps.settle.sinceWheel <= 250, 'Scrolling during a session switch should reveal the transcript', steps.settle);
  check(steps.steady.following && steps.steady.distance < 2 && steps.steady.detached === 0, 'Streaming while following should stay pinned to the bottom', steps.steady);
  check(!steps.select.following && steps.select.distance > 80, 'Dragging a selection above the transcript should stop following', steps.select);
  assert(failures.length === 0, failures.join('\n'));
  return steps;
};

window.verifyBoundary = async () => {
  sessionId.value = 'boundary';
  turns.value = history(0, 40);
  await until(() => body(39)?.textContent.includes('END_39') && distance() < 3, 'short session');
  assert(pane().querySelectorAll('[data-turn-id]').length === 40, 'Short history was unloaded');
  turn(39).querySelector('.tf-head').click();
  await sleep(350);
  turns.value = [...turns.value, ...history(40, 2)];
  await until(() => body(41)?.textContent.includes('END_41') && distance() < 3, 'window threshold');
  assert(!!turn(41).closest('.history-window'), 'Long history was not windowed');
  assert(turn(39).querySelector('.tf-head').getAttribute('aria-expanded') === 'true', 'Expansion lost at threshold');
  return { before: 40, after: 42, following: distance() };
};

window.verifyTools = async () => {
  const count = 600;
  turns.value = turns.value.map(item => item.id === 'turn-101' ? { ...item, tools: Array.from({ length: count }, (_, i) => ({
    id: `many-${i}`, name: 'read', arg: JSON.stringify({ path: `src/many_${i}.ts` }), status: 'ok',
    output: [`TOOL_RESULT_${i}`],
  })) } : item);
  await go(101);
  const group = () => turn(101)?.querySelector('.activity-run');
  assert(group(), 'Tool group missing');
  group().querySelector('.ar-head').click();
  await sleep(500);
  group().scrollIntoView({ block: 'start', behavior: 'instant' });
  await sleep(500);
  const mounted = () => group()?.querySelectorAll('.tool-line').length ?? 0;
  const budget = () => {
    const rows = [...group().querySelectorAll('[data-history-key^="many-"]')]
      .map(el => [Number(el.dataset.historyKey.slice(5)), el.getBoundingClientRect().top])
      .sort((a, b) => a[0] - b[0]);
    const pitches = rows.slice(1).flatMap(([index, top], i) => index === rows[i][0] + 1 ? [top - rows[i][1]] : []).sort((a, b) => a - b);
    return Math.ceil(4 * pane().clientHeight / pitches[Math.floor(pitches.length / 2)]);
  };
  const initialMounted = mounted();
  const initialBudget = budget();
  assert(initialMounted > 0 && initialMounted < initialBudget, `Tool count ${initialMounted} over ${initialBudget}`);
  const first = () => group()?.querySelector('[data-history-key="many-0"]');
  assert(first(), 'First tool missing');
  first().querySelector('.tl-car').click();
  await until(() => first()?.querySelector('.tool-line.open')?.textContent.includes('TOOL_RESULT_0'), 'tool expansion');
  await go(201);
  await until(() => !turn(101), 'tool message unload');
  await go(101);
  assert(group()?.classList.contains('open'), 'Tool group state lost');
  group().scrollIntoView({ block: 'start', behavior: 'instant' });
  await until(() => first()?.querySelector('.tool-line.open')?.textContent.includes('TOOL_RESULT_0'), 'tool state restore');
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  pane().scrollTop += 6000;
  await sleep(800);
  assert(!first(), 'Old tool stayed mounted');
  const afterScroll = mounted();
  const scrollBudget = budget();
  assert(afterScroll > 0 && afterScroll < scrollBudget, `Scrolled tool count ${afterScroll} over ${scrollBudget}`);
  const visibleTool = [...group().querySelectorAll('[data-history-key]')].find(el => el.getBoundingClientRect().top >= pane().getBoundingClientRect().top);
  const toolKey = visibleTool.dataset.historyKey;
  const toolOffset = visibleTool.getBoundingClientRect().top - pane().getBoundingClientRect().top;
  const original = turns.value;
  sessionId.value = 'tools-other';
  turns.value = history(300, 80);
  await until(() => body(379) && distance() < 3, 'tool other session');
  sessionId.value = 'history-a';
  turns.value = original;
  const restoredTool = () => document.querySelector(`[data-history-key="${toolKey}"]`);
  await until(restoredTool, 'tool reading position');
  await sleep(2000);
  const sessionDrift = restoredTool().getBoundingClientRect().top - pane().getBoundingClientRect().top - toolOffset;
  assert(Math.abs(sessionDrift) < 3, `Tool session drift ${sessionDrift}`);
  return { count, initialMounted, afterScroll, sessionDrift, groupState: true, toolState: true };
};

window.prepareHistoryNavigation = async () => {
  await go(101);
  body(101).querySelector('p').style.height = '16000px';
  await sleep(1000);
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
  pane().scrollTop += 8000;
  await until(() => !turn(100), 'preceding question unload');
  await sleep(400);
  pane().scrollTop += 10;
  await sleep(300);
  await tocButton(100);
  assert(document.querySelector('.toc-row.active')?.textContent.trim() === 'Question 100', 'Tall reply highlights the wrong question');
  const row = turn(101).closest('[data-history-key]');
  row.querySelector(':scope > .history-previous').focus({ preventScroll: true });
  assert(document.activeElement?.classList.contains('history-previous'), 'History navigation cannot receive keyboard focus');
  assert(!turn(100), 'Navigation target should start unmounted');
  return { toc: true, source: 'turn-101', target: 'turn-100' };
};

window.finishHistoryNavigation = async () => {
  const focused = key => document.activeElement?.dataset.historyKey === key;
  await until(() => focused('turn-100'), 'keyboard navigation focus');
  assert(turn(100), 'Keyboard navigation did not mount the previous message');
  body(101)?.querySelector('p')?.style.removeProperty('height');
  for (let index = 99; index >= 0; index--) {
    document.activeElement.querySelector(':scope > .history-previous').click();
    await until(() => focused(`turn-${index}`), `previous message ${index}`);
  }
  assert(!document.activeElement.querySelector(':scope > .history-previous'), 'Navigation precedes the first message');
  for (let index = 1; index <= 12; index++) {
    document.activeElement.querySelector(':scope > .history-next').click();
    await until(() => focused(`turn-${index}`), `next message ${index}`);
  }
  await sleep(500);
  const mounted = pane().querySelectorAll('[data-turn-id]').length;
  assert(mounted < 40, `Keyboard navigation retained ${mounted} messages`);
  assert(document.activeElement.getAttribute('role') === 'listitem', 'Focused message has no list semantics');
  assert(document.activeElement.getAttribute('aria-posinset') === '13', 'Focused message position is wrong');
  assert(document.activeElement.getAttribute('aria-setsize') === '240', 'Message count is wrong');
  document.activeElement.blur();
  const toc = document.querySelector('.toc-scroll');
  toc.scrollTop = 0;
  await sleep(400);
  const rows = [...toc.querySelectorAll('[data-history-key]')];
  const edge = rows.filter(el => el.dataset.historyKey !== 'turn-238').at(-1);
  const nextId = Number(edge.dataset.historyKey.slice(5)) + 2;
  assert(!toc.querySelector(`[data-history-key="turn-${nextId}"]`), 'Outline target should start unmounted');
  edge.querySelector(':scope > .history-next').click();
  await until(() => focused(`turn-${nextId}`) && toc.contains(document.activeElement), 'outline navigation');
  document.activeElement.blur();
  await go(13);
  turn(13).querySelector('.a-cpbtn').focus();
  return { keyboard: true, backward: 100, forward: 12, mounted, outline: true };
};

window.verifyToolNavigation = async () => {
  const rows = [...turn(101).querySelectorAll('[data-history-key^="many-"]')];
  const first = rows[0];
  const previous = Number(first.dataset.historyKey.slice(5)) - 1;
  assert(previous >= 0, 'Tool navigation needs an unloaded predecessor');
  assert(!turn(101).querySelector(`[data-history-key="many-${previous}"]`), 'Previous tool should start unmounted');
  first.querySelector(':scope > .history-previous').click();
  await until(() => document.activeElement?.dataset.historyKey === `many-${previous}`, 'tool navigation');
  assert(document.activeElement.getAttribute('aria-setsize') === '600', 'Tool count is wrong');
  document.activeElement.querySelector('.tl-car').click();
  await until(() => document.activeElement?.textContent.includes(`TOOL_RESULT_${previous}`), 'navigated tool content');
  return { target: previous, focused: true, content: true };
};

window.verifyHistoryTab = async () => {
  await until(() => document.activeElement?.classList.contains('history-next'), 'Tab reaches next item');
  const button = document.activeElement;
  const rect = button.getBoundingClientRect();
  const view = pane().getBoundingClientRect();
  assert(button.closest('[data-history-key]')?.dataset.historyKey === 'turn-13', 'Tab skipped the current message');
  assert(rect.width > 1 && rect.height > 1 && getComputedStyle(button).clipPath === 'none', 'Focused navigation is visually hidden');
  assert(rect.bottom > view.top && rect.top < view.bottom, 'Focused navigation is outside the viewport');
  return { tab: true, visible: true };
};
window.verifyHistoryEnter = async () => {
  await until(() => document.activeElement?.dataset.historyKey === 'turn-14', 'Enter opens next message');
  return { enter: true, target: 'turn-14' };
};
