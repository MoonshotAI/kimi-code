// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BrowserControlSurfaceView from '../../src/renderer/components/browser/BrowserControlSurface.vue';
import type { BrowserControlActivity, BrowserControlSurface, BrowserControlSurfaceBridge } from '../../src/shared/browser-control';

const labels: BrowserControlSurface['labels'] = {
  running: 'Agent is in control', elapsed: '{time}', takeover: 'Take over', takeoverHint: 'Stop', pointer: 'Agent', typing: 'Typing', key: 'Keys', scrolling: 'Scrolling',
  activityTarget: '{activity} “{target}”',
  activities: { reading: 'Reading page text', inspecting: 'Looking at elements', capturing: 'Capturing', clicking: 'Clicking', hovering: 'Hovering', typing: 'Typing', pressing: 'Pressing', selecting: 'Selecting', checking: 'Checking', scrolling: 'Scrolling', dragging: 'Dragging', navigating: 'Opening page', waiting: 'Waiting', answering: 'Answering' },
};

let app: App | null = null;
let host: HTMLDivElement;
let emitSurface: (surface: BrowserControlSurface | null) => void;
let emitActivity: (activity: BrowserControlActivity) => void;

beforeEach(async () => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  const bridge: BrowserControlSurfaceBridge = {
    ready: () => {}, takeOver: () => {}, downloadAction: () => {},
    onDialogs: () => () => {},
    onSurface: (cb) => { emitSurface = cb; return () => {}; },
    onPointer: () => () => {},
    onActivity: (cb) => { emitActivity = cb; return () => {}; },
    onResizing: () => () => {},
  };
  (window as { kimiBrowserControl?: BrowserControlSurfaceBridge }).kimiBrowserControl = bridge;
  app = createApp(BrowserControlSurfaceView);
  app.mount(host);
  emitSurface({ browserId: 'page', revision: 3, startedAt: Date.now(), labels, colorScheme: 'light', reducedMotion: false, corners: [0, 0, 15, 0], insets: [0, 1, 1, 0] });
  await nextTick();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.useRealTimers();
});

const title = () => host.querySelector('.control-title')?.textContent;

it('says what the agent is doing, names and boxes the target, then settles back', async () => {
  expect(title()).toBe('Agent is in control');
  emitActivity({ browserId: 'page', revision: 3, id: 1, activity: 'clicking', scan: false });
  await nextTick();
  expect(title()).toBe('Clicking');
  expect(host.querySelector('.control-target')).toBeNull();

  emitActivity({ browserId: 'page', revision: 3, id: 1, activity: 'clicking', scan: false, target: 'Send', rect: { x: 40, y: 60, width: 120, height: 32 } });
  await nextTick();
  expect(title()).toBe('Clicking “Send”');
  const box = host.querySelector<HTMLElement>('.control-target')!;
  expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['40px', '60px', '120px', '32px']);
});

it('keeps the title for a second after the operation ends, however long it ran', async () => {
  emitActivity({ browserId: 'page', revision: 3, id: 2, activity: 'waiting', scan: false });
  vi.advanceTimersByTime(5000);
  emitActivity({ browserId: 'page', revision: 3, activity: null });
  await nextTick();
  vi.advanceTimersByTime(900);
  await nextTick();
  expect(title()).toBe('Waiting');
  vi.advanceTimersByTime(200);
  await nextTick();
  expect(title()).toBe('Agent is in control');
});

it('shows the target box long enough to be seen, then removes it before the title', async () => {
  emitActivity({ browserId: 'page', revision: 3, id: 3, activity: 'typing', scan: false, target: 'Search', rect: { x: 1, y: 2, width: 30, height: 40 } });
  vi.advanceTimersByTime(50);
  emitActivity({ browserId: 'page', revision: 3, activity: null });
  await nextTick();
  expect(host.querySelector('.control-target')).not.toBeNull();
  vi.advanceTimersByTime(600);
  await nextTick();
  expect(host.querySelector('.control-target')).toBeNull();
  expect(title()).toBe('Typing “Search”');

  emitActivity({ browserId: 'page', revision: 3, id: 4, activity: 'clicking', scan: false, target: 'Send', rect: { x: 1, y: 2, width: 30, height: 40 } });
  vi.advanceTimersByTime(3000);
  emitActivity({ browserId: 'page', revision: 3, activity: null });
  await nextTick();
  expect(host.querySelector('.control-target')).toBeNull();
  expect(title()).toBe('Clicking “Send”');
});

it('lets a scan finish after a read that ended quickly', async () => {
  emitActivity({ browserId: 'page', revision: 3, id: 5, activity: 'reading', scan: true });
  emitActivity({ browserId: 'page', revision: 3, activity: null });
  vi.advanceTimersByTime(1050);
  await nextTick();
  expect(title()).toBe('Agent is in control');
  expect(host.querySelectorAll('.control-scan')).toHaveLength(1);
  host.querySelector('.control-scan')!.dispatchEvent(new Event('animationend'));
  await nextTick();
  expect(host.querySelectorAll('.control-scan')).toHaveLength(0);
});

it('sweeps the page once for each read and ignores stale surfaces', async () => {
  emitActivity({ browserId: 'page', revision: 2, id: 6, activity: 'reading', scan: true });
  await nextTick();
  expect(title()).toBe('Agent is in control');
  expect(host.querySelector('.control-scan')).toBeNull();

  emitActivity({ browserId: 'page', revision: 3, id: 7, activity: 'reading', scan: true });
  await nextTick();
  expect(title()).toBe('Reading page text');
  expect(host.querySelectorAll('.control-scan')).toHaveLength(1);

  emitActivity({ browserId: 'page', revision: 3, activity: null });
  emitActivity({ browserId: 'page', revision: 3, id: 8, activity: 'inspecting', scan: true });
  await nextTick();
  expect(title()).toBe('Looking at elements');
  vi.advanceTimersByTime(1000);
  await nextTick();
  expect(title()).toBe('Looking at elements');
});

it('drops the activity when the surface changes', async () => {
  emitActivity({ browserId: 'page', revision: 3, id: 9, activity: 'typing', scan: false, target: 'Search', rect: { x: 1, y: 2, width: 3, height: 4 } });
  await nextTick();
  emitSurface({ browserId: 'page', revision: 4, startedAt: Date.now(), labels, colorScheme: 'light', reducedMotion: false, corners: [0, 0, 15, 0], insets: [0, 1, 1, 0] });
  await nextTick();
  expect(title()).toBe('Agent is in control');
  expect(host.querySelector('.control-target')).toBeNull();
});

it('sweeps once for a read that is shown again after a newer activity', async () => {
  emitActivity({ browserId: 'page', revision: 3, id: 20, activity: 'reading', scan: true });
  emitActivity({ browserId: 'page', revision: 3, id: 21, activity: 'clicking', scan: false });
  emitActivity({ browserId: 'page', revision: 3, id: 20, activity: 'reading', scan: true });
  await nextTick();
  expect(title()).toBe('Reading page text');
  expect(host.querySelectorAll('.control-scan')).toHaveLength(1);
  emitActivity({ browserId: 'page', revision: 3, id: 22, activity: 'reading', scan: true });
  await nextTick();
  expect(host.querySelectorAll('.control-scan')).toHaveLength(2);
});

it('keeps the current controller visible during idle and activity and refreshes it on transfer', async () => {
  const next = { browserId: 'page', revision: 4, startedAt: Date.now(), controller: 'coder · Inspect docs', labels, colorScheme: 'light' as const, reducedMotion: false, corners: [0, 0, 15, 0] as [number, number, number, number], insets: [0, 1, 1, 0] as [number, number, number, number] };
  emitSurface(next);
  await nextTick();
  expect(title()).toBe('coder · Inspect docs · Agent is in control');
  expect(host.querySelector('.control-toolbar')!.getAttribute('aria-label')).toBe(title());
  emitActivity({ browserId: 'page', revision: 4, id: 30, activity: 'clicking', scan: false });
  await nextTick();
  expect(title()).toBe('coder · Inspect docs · Clicking');
  emitSurface({ ...next, revision: 5, controller: 'agent-2' });
  await nextTick();
  expect(title()).toBe('agent-2 · Agent is in control');
});
