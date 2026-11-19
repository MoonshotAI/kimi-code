// @vitest-environment jsdom
import { createApp, h, ref, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { FetchTurnFileContentKey } from '@moonshot-ai/app-client/contracts';
import { buildWholeFileDiffLines, type WholeFileDiffUnavailable } from '@moonshot-ai/app-core/client';
import type { TurnDiffResult } from '../src/chat/turnDiff.worker';
import TurnDiffPanel from '../src/chat/TurnDiffPanel.vue';

class TestWorker {
  static instances: TestWorker[] = [];
  static automatic = true;
  onmessage: ((event: { data: TurnDiffResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  input: { before: string; after: string } | undefined;
  constructor() { TestWorker.instances.push(this); }
  postMessage(input: { before: string; after: string }) {
    this.input = input;
    if (TestWorker.automatic) queueMicrotask(() => this.complete());
  }
  complete() {
    let unavailable: WholeFileDiffUnavailable | undefined;
    const lines = buildWholeFileDiffLines(this.input!.before, this.input!.after, (detail) => { unavailable = detail; }, 20_000);
    this.onmessage?.({ data: { lines, unavailable } });
  }
}

beforeEach(() => {
  TestWorker.instances = [];
  TestWorker.automatic = true;
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('renders additions from fetched snapshots across a 2830-line file', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const lineCount = 2830;
  const oldLines = Array.from({ length: lineCount }, (_, i) => `source file line ${i + 1}`);
  const newLines = [
    'added at start',
    ...oldLines.slice(0, 950),
    'added near first third',
    ...oldLines.slice(950, 1900),
    'added near second third',
    ...oldLines.slice(1900),
    'added at end',
  ];
  const before = `${oldLines.join('\n')}\n`;
  const after = `${newLines.join('\n')}\n`;
  const fetchContent = vi.fn(async (_turnId: number, _path: string, phase: 'start' | 'end') => ({
    version: phase === 'start' ? 2 : 3,
    content: phase === 'start' ? before : after,
  }));

  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(TurnDiffPanel, {
      change: { path: 'large-file.txt', added: 4, removed: 0 },
      daemonTurnId: 23,
      sessionId: 'session-1',
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, fetchContent);
  app.mount(host);

  await vi.waitFor(() => expect(host!.querySelectorAll('.hl-row')).toHaveLength(lineCount + 4), { timeout: 10_000 });
  expect(fetchContent).toHaveBeenCalledWith(23, 'large-file.txt', 'start', 'session-1');
  expect(fetchContent).toHaveBeenCalledWith(23, 'large-file.txt', 'end', 'session-1');
  expect([...host.querySelectorAll('.row-add .hl-text')].map((row) => row.textContent)).toEqual([
    'added at start',
    'added near first third',
    'added near second third',
    'added at end',
  ]);
  expect(host.querySelector('.row-del')).toBeNull();
  expect(host.querySelector('.td-empty')).toBeNull();
  expect(host.querySelector('.hl-row:last-child .hl-text')?.textContent).toBe('added at end');
});

it.each([
  { name: 'missing snapshot', start: undefined, end: { version: 2, content: 'line\n' }, reason: 'snapshot_missing' },
  { name: 'binary snapshot', start: { version: 1, binary: true }, end: { version: 2, content: 'line\n' }, reason: 'binary_snapshot' },
  { name: 'missing end snapshot', start: { version: 1, content: 'line\n' }, end: undefined, reason: 'snapshot_missing' },
  { name: 'binary end snapshot', start: { version: 1 }, end: { version: 2, binary: true }, reason: 'binary_snapshot' },
  { name: 'too many characters', start: { version: 1, content: 'x'.repeat(1024 * 1024 + 1) }, end: { version: 2, content: 'line\n' }, reason: 'character_limit' },
  { name: 'too many lines', start: { version: 1, content: `${Array(20_001).fill('line').join('\n')}\n` }, end: { version: 2, content: 'line\n' }, reason: 'line_limit' },
  { name: 'empty diff', start: { version: 1, content: '' }, end: { version: 2, content: '' }, reason: 'empty_diff' },
])('logs $name when the line diff is unavailable', async ({ start, end, reason }) => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(TurnDiffPanel, {
      change: { path: 'large-file.txt', added: 1, removed: 0 },
      daemonTurnId: 23,
      sessionId: 'session-1',
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, async (_turnId, _path, phase) => phase === 'start' ? start : end);
  app.mount(host);

  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('turn file diff unavailable', expect.objectContaining({
    reason,
    turnId: 23,
    path: 'large-file.txt',
  })));
  expect(host.querySelector('.td-empty')).not.toBeNull();
});

function mountPendingPanel() {
  TestWorker.automatic = false;
  const turnId = ref<number | undefined>(23);
  const sessionId = ref('session-1');
  const change = ref({ path: 'first.txt', added: 1, removed: 0 });
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(TurnDiffPanel, { change: change.value, daemonTurnId: turnId.value, sessionId: sessionId.value }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, async (_turnId, path, phase, session) => ({ version: 1, content: phase === 'start' ? '' : `${session}/${path}\n` }));
  app.mount(host);
  return { turnId, sessionId, change };
}

it.each(['file', 'session', 'turn'] as const)('terminates pending work and ignores stale results on a %s change', async (kind) => {
  const state = mountPendingPanel();
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
  const oldWorker = TestWorker.instances[0]!;
  if (kind === 'file') state.change.value = { path: 'second.txt', added: 1, removed: 0 };
  if (kind === 'session') state.sessionId.value = 'session-2';
  if (kind === 'turn') state.turnId.value = 24;
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(2));
  expect(oldWorker.terminate).toHaveBeenCalled();
  oldWorker.complete();
  await nextTick();
  expect(host!.querySelector('.hl-row')).toBeNull();
  TestWorker.instances[1]!.complete();
  await vi.waitFor(() => expect(host!.querySelector('.row-add .hl-text')?.textContent).toBe(`${state.sessionId.value}/${state.change.value.path}`));
  expect(TestWorker.instances[1]!.terminate).toHaveBeenCalled();
});

it('terminates pending computation when the panel unmounts', async () => {
  mountPendingPanel();
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
  app!.unmount();
  app = undefined;
  expect(TestWorker.instances[0]!.terminate).toHaveBeenCalled();
});

it('clears loading when the next turn has no snapshot identity', async () => {
  const { turnId } = mountPendingPanel();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
  turnId.value = undefined;
  await nextTick();
  expect(TestWorker.instances[0]!.terminate).toHaveBeenCalled();
  expect(host!.querySelector('.td-empty button')).not.toBeNull();
});

it.each(['error', 'messageerror'] as const)('logs a worker %s and leaves the loading state', async (kind) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mountPendingPanel();
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
  const worker = TestWorker.instances[0]!;
  if (kind === 'error') worker.onerror?.({ message: 'Worker failed to load' });
  else worker.onmessageerror?.();
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('turn file diff unavailable', expect.objectContaining({ reason: 'exception' })));
  expect(worker.terminate).toHaveBeenCalled();
  expect(host!.querySelector('.td-empty button')).not.toBeNull();
});

it('does not start a worker for a snapshot request superseded before it completes', async () => {
  const session = ref('old-session');
  const change = { path: 'same.txt', added: 1, removed: 0 };
  const pending: Array<() => void> = [];
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(TurnDiffPanel, { change, daemonTurnId: 23, sessionId: session.value }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, (_turn, _path, phase, sessionId) => new Promise((resolve) => {
    pending.push(() => resolve({ version: 1, content: phase === 'start' ? '' : `${sessionId}\n` }));
  }));
  app.mount(host);
  session.value = 'new-session';
  await nextTick();
  expect(pending).toHaveLength(4);
  pending[2]!();
  pending[3]!();
  await vi.waitFor(() => expect(host!.querySelector('.row-add .hl-text')?.textContent).toBe('new-session'));
  pending[0]!();
  pending[1]!();
  await nextTick();
  expect(TestWorker.instances).toHaveLength(1);
  expect(host!.querySelector('.row-add .hl-text')?.textContent).toBe('new-session');
});

it('keeps the loading indicator visible until the worker responds', async () => {
  mountPendingPanel();
  await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
  expect(host!.textContent).toContain('Loading this turn’s changes…');
  expect(host!.querySelector('.hl-row')).toBeNull();
  TestWorker.instances[0]!.complete();
  await vi.waitFor(() => expect(host!.querySelector('.row-add')).not.toBeNull());
  expect(host!.textContent).not.toContain('Loading this turn’s changes…');
});

it.each([
  { name: 'added', start: { version: 1 }, end: { version: 2, content: 'first\nsecond\n' }, rowClass: 'row-add', opposite: 'row-del' },
  { name: 'deleted', start: { version: 1, content: 'first\nsecond\n' }, end: { version: 2 }, rowClass: 'row-del', opposite: 'row-add' },
])('renders $name files when the absent side has only a version', async ({ start, end, rowClass, opposite }) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(TurnDiffPanel, {
    change: { path: 'file.txt', added: 2, removed: 0 },
    daemonTurnId: 3,
    sessionId: 'session-1',
  }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, async (_turn, _path, phase) => phase === 'start' ? start : end);
  app.mount(host);
  await vi.waitFor(() => expect(host!.querySelectorAll(`.${rowClass}`)).toHaveLength(2));
  expect([...host.querySelectorAll(`.${rowClass} .hl-text`)].map(row => row.textContent)).toEqual(['first', 'second']);
  expect(host.querySelector(`.${opposite}`)).toBeNull();
  expect(host.querySelector('.td-empty')).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});

it.each(['addition', 'deletion'])('opens at the first %s with three context rows and does not jump again on wrap', async (kind) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const body = this.closest('.td-body');
    const rows = body ? [...body.querySelectorAll('.hl-row')] : [];
    const top = this.classList.contains('hl-row') ? 100 + rows.indexOf(this) * 20 - (body?.scrollTop ?? 0) : 100;
    return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON() {} };
  });
  const prefix = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const before = kind === 'addition' ? prefix : prefix + 'changed\n';
  const after = kind === 'addition' ? prefix + 'changed\n' : prefix;
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(TurnDiffPanel, { change: { path: 'file.txt', added: 1, removed: 0 }, daemonTurnId: 1 }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileContentKey, async (_turn, _path, phase) => ({ version: 1, content: phase === 'start' ? before : after }));
  app.mount(host);
  await vi.waitFor(() => expect(host!.querySelector('.td-body')?.scrollTop).toBe(1940));
  const body = host.querySelector<HTMLElement>('.td-body')!;
  body.scrollTop = 400;
  host.querySelector<HTMLButtonElement>('[aria-label="Enable word wrap"]')!.click();
  await nextTick();
  expect(body.scrollTop).toBe(400);
});
