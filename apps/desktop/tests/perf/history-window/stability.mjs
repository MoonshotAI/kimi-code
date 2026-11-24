import { nextTick } from 'vue';
import { pendingPromptTurn } from '@moonshot-ai/app-core/client';
import { createStabilityProbe, describeStabilityTarget } from '@moonshot-ai/app-core/lib';
import { turns, sessionId, active, setOlder, timing } from './client.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const rawScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
const pane = () => document.querySelector('.panes');
const turnEl = id => pane()?.querySelector(`[data-turn-id="${id}"]`);
const distance = () => pane().scrollHeight - pane().scrollTop - pane().clientHeight;
const PLACEHOLDER = '.transcript-space';

let fileChangeDelay = 0;
let fileChangeCount = 0;
export function turnFileChanges() {
  const changes = Array.from({ length: fileChangeCount }, (_, i) => ({ path: `src/feature/file_${i}.ts`, additions: 12 + i, deletions: i, binary: false, oversize: false, status: 'modified' }));
  return new Promise(resolve => setTimeout(() => resolve(changes), fileChangeDelay));
}

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

function afterPaint() {
  return new Promise(resolve => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  }));
}

async function trackFrames(read, ms) {
  const values = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await afterPaint();
    values.push({ t: performance.now(), v: read() });
  }
  return values;
}

function setScrollTop(value) { rawScrollTop.set.call(pane(), value); }

async function userWheel(probe, deltaY) {
  probe.markInput();
  pane().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
  setScrollTop(pane().scrollTop + deltaY);
  await frame();
}

const pngCache = new Map();
function pngImage(width = 640, height = 320, color = '#88aaff') {
  const key = `${width}x${height}${color}`;
  if (!pngCache.has(key)) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    pngCache.set(key, canvas.toDataURL('image/png'));
  }
  return pngCache.get(key);
}

function codeBlock(lang, lines, tag) {
  return `\`\`\`${lang}\n${Array.from({ length: lines }, (_, j) => `const ${tag}_${j} = compute("${'value '.repeat(6)}", ${j});`).join('\n')}\n\`\`\``;
}

function answer(i) {
  return [
    `## Result ${i}`,
    `A **summary** for item ${i} that wraps across a couple of lines in the transcript column to exercise text layout.`,
    codeBlock('ts', 6, `short_${i}`),
    Array.from({ length: 4 }, (_, j) => `Paragraph ${j}: the result stays readable while surrounding content changes height.`).join('\n\n'),
    i % 3 === 0 ? codeBlock('ts', 80, `long_${i}`) : '',
    `| Name | Value |\n| --- | --- |\n| sample | ${i} |\n| other | ${i * 2} |`,
    i % 4 === 0 ? `![chart ${i}](${pngImage()})` : '',
    `END_${i}`,
  ].filter(Boolean).join('\n\n');
}

function writeTools(id) {
  if (fileChangeCount === 0) return [{ id: `${id}-tool`, name: 'read', arg: JSON.stringify({ path: `src/${id}.ts` }), status: 'ok', output: ['Read file'] }];
  return Array.from({ length: fileChangeCount }, (_, k) => ({ id: `${id}-tool-${k}`, name: 'write', arg: JSON.stringify({ path: `src/feature/file_${k}.ts` }), status: 'ok', output: ['Wrote file'] }));
}

function fixture(session, count, start = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const i = start + offset;
    const n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) {
      return pendingPromptTurn({ id: `${session}-${i}`, sessionId: session, role: 'user', content: [{ type: 'text', text: `Question ${n}` }], createdAt: '2026-01-01T00:00:00.000Z' }, n, { sessionId: session });
    }
    return {
      id: `${session}-${i}`, sessionId: session, role: 'assistant', no: n, daemonTurnId: n, daemonTurnState: 'completed',
      text: answer(i), thinking: 'Retained reasoning for this answer.',
      tools: writeTools(`${session}-${i}`),
    };
  });
}

function streamingChunks() {
  const doc = [
    'Here is the plan with code, a table and an image.',
    codeBlock('ts', 6, 'stream_a'),
    Array.from({ length: 6 }, (_, j) => `Streaming paragraph ${j}: ${'tokens arrive and the layout grows '.repeat(3)}`).join('\n\n'),
    codeBlock('ts', 80, 'stream_long'),
    `| Step | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |`,
    '![streamed](assets/streamed.png)',
    codeBlock('py', 10, 'stream_b'),
    'STREAM_END',
  ].join('\n\n');
  const chunks = [];
  for (let i = 0; i < doc.length; i += 48) chunks.push(doc.slice(0, i + 48));
  return chunks;
}

async function openSession(id, count, { streaming = false } = {}) {
  sessionId.value = id;
  const base = fixture(id, count);
  if (streaming) {
    const last = base.at(-1);
    base[base.length - 1] = { ...last, text: '', thinking: undefined, tools: [], daemonTurnState: 'running' };
    active.value = true;
  }
  turns.value = base;
  await nextTick();
  await until(() => turnEl(base.at(-1).id) && distance() < 2, `open ${id}`);
  await sleep(1200);
  return base;
}

function setLastText(text, extra = {}) {
  const list = turns.value;
  turns.value = [...list.slice(0, -1), { ...list.at(-1), text, ...extra }];
}

function readingElement() {
  const rect = pane().getBoundingClientRect();
  const y = rect.top + pane().clientHeight * 0.25;
  for (const fraction of [0.5, 0.25, 0.75]) {
    const el = document.elementFromPoint(rect.left + rect.width * fraction, y);
    if (el && el !== pane() && pane().contains(el) && !el.closest(PLACEHOLDER) && !el.querySelector('[data-turn-id]')) return el;
  }
  return null;
}

function offsetOf(el) { return el.getBoundingClientRect().top - pane().getBoundingClientRect().top; }

function readingAnchor() {
  const el = readingElement();
  const line = pane().clientHeight * 0.25;
  const row = el?.closest('[data-turn-id]') ?? [...pane().querySelectorAll('[data-turn-id]')].find(item => offsetOf(item) + item.getBoundingClientRect().height > line);
  if (!row) return null;
  return { id: row.dataset.turnId, label: describeStabilityTarget(el ?? row), top: offsetOf(row) };
}

function anchorOffset(anchor) {
  const row = anchor ? turnEl(anchor.id) : null;
  return row ? offsetOf(row) - anchor.top : null;
}

function drift(series) {
  const values = series.map(item => item.v).filter(v => v !== null);
  if (values.length === 0) return { frames: series.length, max: null, final: null, moves: 0 };
  let moves = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - values[i - 1]) > 1) moves++;
  return { frames: series.length, max: Math.round(Math.max(...values.map(v => Math.abs(v)))), final: Math.round(values.at(-1)), moves };
}

async function stream(probe) {
  const phases = {};
  probe.reset();
  for (const text of streamingChunks()) {
    setLastText(text);
    await sleep(30);
  }
  await sleep(300);
  phases.stream = probe.report();
  probe.reset();
  active.value = false;
  setLastText(turns.value.at(-1).text, { daemonTurnState: 'completed', tools: writeTools(turns.value.at(-1).id) });
  await sleep(1800);
  phases.settle = probe.report();
  return phases;
}

async function scenarioFollowStream(probe) {
  fileChangeCount = 3;
  fileChangeDelay = 300;
  await openSession('st-follow', 30, { streaming: true });
  const phases = await stream(probe);
  return { ...phases, finalDistance: Math.round(distance()) };
}

async function scenarioReadAboveStream(probe) {
  fileChangeCount = 3;
  fileChangeDelay = 300;
  await openSession('st-read', 30, { streaming: true });
  await userWheel(probe, -900);
  await sleep(400);
  const anchor = readingAnchor();
  assert(anchor, 'No reading element above the stream');
  const phases = await stream(probe);
  return { ...phases, anchor: anchor.label, readingDrift: Math.round(anchorOffset(anchor) ?? NaN) };
}

async function scenarioTurnDiffOnOpen(probe) {
  fileChangeCount = 4;
  fileChangeDelay = 500;
  sessionId.value = 'st-diff';
  turns.value = fixture('st-diff', 30);
  await nextTick();
  await until(() => turnEl('st-diff-29'), 'diff session');
  await userWheel(probe, -260);
  await frame();
  probe.reset();
  const anchor = readingAnchor();
  const series = await trackFrames(() => anchorOffset(anchor), 1500);
  return { probe: probe.report(), anchor: anchor?.label, anchorDrift: drift(series) };
}

function textEl(text) {
  return [...pane().querySelectorAll('.paragraph-node, p')].find(el => el.textContent.startsWith(text)) ?? null;
}

function heavyDoc() {
  return ['Heavy answer with many code blocks.', ...Array.from({ length: 34 }, (_, k) => `Block ${k} explanation.\n\n${codeBlock('ts', 3, `heavy_${k}`)}`), 'HEAVY_END'].join('\n\n');
}

async function scenarioStreamEndRead(probe, name, doc, marker) {
  fileChangeCount = 3;
  fileChangeDelay = 300;
  await openSession(name, 20, { streaming: true });
  for (let i = 0; i < doc.length; i += 160) {
    setLastText(doc.slice(0, i + 160));
    await sleep(30);
  }
  setLastText(doc);
  await sleep(600);
  const el = textEl(marker);
  assert(el, `marker ${marker} missing`);
  await userWheel(probe, offsetOf(el) - pane().clientHeight * 0.4);
  await sleep(500);
  const before = offsetOf(textEl(marker));
  probe.reset();
  active.value = false;
  setLastText(doc, { daemonTurnState: 'completed', tools: writeTools(turns.value.at(-1).id) });
  const series = await trackFrames(() => {
    const e = textEl(marker);
    return e ? offsetOf(e) - before : null;
  }, 1500);
  return { probe: probe.report(), elementDrift: drift(series) };
}

function mediaDoc(tag) {
  return [
    `## Media ${tag}`,
    'Intro paragraph before the diagram.',
    '```mermaid\ngraph TD\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -->|no| D[Retry]\n  D --> B\n  C --> E[Report]\n```',
    'Paragraph between the diagram and the image.',
    `![local chart](assets/${tag}-chart.png)`,
    'Paragraph after the local image.',
    `![remote chart](${pngImage()})`,
    `MEDIA_END_${tag}`,
    ...Array.from({ length: 14 }, (_, k) => `Trailing paragraph ${k} keeps reading content below the media.`),
  ].join('\n\n');
}

function mediaFixture(session, count) {
  const list = fixture(session, count);
  list[list.length - 1] = { ...list.at(-1), text: mediaDoc(session), tools: [] };
  return list;
}

let imageDelay = 50;

async function scenarioMediaOpen(probe) {
  fileChangeCount = 0;
  imageDelay = 900;
  const media = mediaFixture('st-media', 20);
  const marker = 'MEDIA_END_st-media';
  const visit = async (first) => {
    sessionId.value = 'st-media';
    turns.value = media;
    await until(() => turnEl('st-media-19') && textEl(marker) && (!first || distance() < 2), 'media session');
    if (first) await userWheel(probe, offsetOf(textEl(marker)) - pane().clientHeight * 0.6);
    await frame();
    const before = offsetOf(textEl(marker));
    probe.reset();
    const series = await trackFrames(() => {
      const e = textEl(marker);
      return e ? offsetOf(e) - before : null;
    }, 1500);
    return { probe: probe.report(), elementDrift: drift(series) };
  };
  const first = await visit(true);
  sessionId.value = 'st-media-other';
  turns.value = fixture('st-media-other', 6);
  await sleep(800);
  const second = await visit(false);
  imageDelay = 50;
  return { first, second };
}

async function scenarioLoadOlder(probe) {
  fileChangeCount = 0;
  timing.olderDelayMs = 600;
  sessionId.value = 'st-older';
  const newer = fixture('st-older', 40, 40);
  turns.value = newer;
  setOlder(fixture('st-older', 40, 0));
  await nextTick();
  await until(() => turnEl('st-older-79') && distance() < 2, 'older session');
  await sleep(800);
  for (let i = 0; i < 40 && pane().scrollTop > 0; i++) await userWheel(probe, -1500);
  await sleep(100);
  const anchor = { id: 'st-older-40', top: offsetOf(turnEl('st-older-40')) };
  const reading = readingAnchor();
  probe.reset();
  const series = await trackFrames(() => anchorOffset(anchor), 2200);
  timing.olderDelayMs = 120;
  return { probe: probe.report(), probeReading: reading?.label ?? null, loaded: turns.value.length === 80, anchorDrift: drift(series) };
}

async function scenarioSessionSwitch(probe) {
  fileChangeCount = 3;
  fileChangeDelay = 200;
  const a = await openSession('st-a', 200);
  for (let i = 0; i < 6; i++) await userWheel(probe, -1500);
  await sleep(600);
  const anchor = readingElement();
  const turnId = anchor?.closest('[data-turn-id]')?.dataset.turnId ?? readingAnchor()?.id;
  assert(turnId, 'No anchor turn in session A');
  const before = offsetOf(turnEl(turnId));
  await openSession('st-b', 60);
  probe.markInput();
  probe.reset();
  sessionId.value = 'st-a';
  turns.value = a;
  const switched = performance.now();
  const series = await trackFrames(() => {
    const el = turnEl(turnId);
    if (!el || getComputedStyle(el).visibility === 'hidden') return null;
    return offsetOf(el) - before;
  }, 2000);
  const visible = series.filter(item => item.v !== null);
  return {
    probe: probe.report(),
    msToVisible: visible.length ? Math.round(visible[0].t - switched) : null,
    firstVisibleError: visible.length ? Math.round(visible[0].v) : null,
    maxErrorAfterVisible: visible.length ? Math.round(Math.max(...visible.map(item => Math.abs(item.v)))) : null,
    finalError: visible.length ? Math.round(visible.at(-1).v) : null,
    movesAfterVisible: drift(visible).moves,
  };
}

async function scenarioDisclosure(probe) {
  const head = [...pane().querySelectorAll('.tf-head')].find(el => offsetOf(el) > 0) ?? pane().querySelector('.tf-head');
  if (!head) return { skipped: 'no fold head' };
  probe.markInput();
  setScrollTop(pane().scrollTop + offsetOf(head) - pane().clientHeight / 2);
  await sleep(800);
  if (!head.isConnected) return { skipped: 'fold head unmounted after positioning' };
  const results = {};
  for (const step of ['expand', 'collapse']) {
    await sleep(300);
    probe.reset();
    const before = offsetOf(head);
    head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    head.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    head.click();
    const series = await trackFrames(() => (head.isConnected ? offsetOf(head) - before : null), 1000);
    results[step] = { anchorDrift: drift(series), finalDrift: head.isConnected ? Math.round(offsetOf(head) - before) : 'detached' };
  }
  return results;
}

async function scenarioTocJump(probe) {
  if (sessionId.value !== 'st-a') return { skipped: 'tocJump runs after sessionSwitch' };
  const rail = document.querySelector('.toc-scroll');
  if (!rail) return { skipped: 'no toc rail' };
  const label = 'Question 20';
  let button = null;
  for (let top = 0; top < 4000 && !button; top += 40) {
    rail.scrollTop = top;
    await frame();
    button = rail.querySelector(`.toc-row[aria-label="${label}"]`);
  }
  if (!button) return { skipped: 'toc row not found' };
  probe.reset();
  const clicked = performance.now();
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  button.click();
  const target = () => pane().querySelector('[data-turn-id="st-a-38"]');
  const series = await trackFrames(() => {
    const el = target();
    return el ? offsetOf(el) + el.getBoundingClientRect().height / 2 - pane().clientHeight / 2 : null;
  }, 3000);
  const late = series.filter(item => item.t - clicked > 700 && item.v !== null);
  const arrived = series.find(item => item.v !== null && Math.abs(item.v) < 100);
  return {
    probe: probe.report(),
    msToArrive: arrived ? Math.round(arrived.t - clicked) : null,
    movesAfter700ms: drift(late).moves,
    finalCenterError: series.at(-1)?.v === null ? null : Math.round(series.at(-1).v),
  };
}

async function scenarioReflow(probe, apply, revert) {
  await sleep(400);
  const anchor = readingAnchor();
  if (!anchor) return { skipped: 'no reading element' };
  probe.reset();
  apply();
  const series = await trackFrames(() => anchorOffset(anchor), 1200);
  const result = { probe: probe.report(), anchor: anchor.label, anchorDrift: drift(series) };
  revert();
  await sleep(800);
  return result;
}

async function scenarioFastScroll(probe) {
  setScrollTop(pane().scrollHeight);
  await sleep(600);
  probe.reset();
  for (let i = 0; i < 60; i++) {
    probe.markInput();
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
    setScrollTop(pane().scrollTop - 500);
    await frame();
  }
  for (let i = 0; i < 30; i++) {
    probe.markInput();
    pane().dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true }));
    setScrollTop(pane().scrollTop + 1000);
    await frame();
  }
  await sleep(300);
  return { probe: probe.report() };
}

window.runStability = async (only = '') => {
  window.__setImageResolver(async src => {
    if (!src.startsWith('assets/')) return src;
    await sleep(imageDelay);
    return pngImage(480, 360, '#ffaa66');
  });
  const selected = only ? new Set(only.split(',')) : null;
  const probe = createStabilityProbe(pane(), { placeholderSelector: PLACEHOLDER });
  const results = {};
  const run = async (name, fn) => {
    if (selected && !selected.has(name)) return;
    try { results[name] = await fn(); }
    catch (error) { results[name] = { error: String(error?.message ?? error) }; }
  };
  try {
    await run('followStream', () => scenarioFollowStream(probe));
    await run('readAboveStream', () => scenarioReadAboveStream(probe));
    await run('turnDiffOnOpen', () => scenarioTurnDiffOnOpen(probe));
    await run('loadOlder', () => scenarioLoadOlder(probe));
    await run('streamEndCode', () => scenarioStreamEndRead(probe, 'st-code', streamingChunks().at(-1), 'Streaming paragraph 3'));
    await run('streamEndHeavy', () => scenarioStreamEndRead(probe, 'st-heavy', heavyDoc(), 'Block 20 explanation.'));
    await run('mediaOpen', () => scenarioMediaOpen(probe));
    await run('sessionSwitch', () => scenarioSessionSwitch(probe));
    await run('disclosure', () => scenarioDisclosure(probe));
    await run('tocJump', () => scenarioTocJump(probe));
    const host = document.querySelector('#app');
    await run('widthChange', () => scenarioReflow(probe, () => { host.style.width = '70%'; }, () => { host.style.width = ''; }));
    await run('fontScale', () => scenarioReflow(probe, () => { document.documentElement.dataset.fontScale = 'large'; }, () => { document.documentElement.dataset.fontScale = 'medium'; }));
    await run('fastScroll', () => scenarioFastScroll(probe));
  } finally {
    probe.stop();
  }
  return results;
};
