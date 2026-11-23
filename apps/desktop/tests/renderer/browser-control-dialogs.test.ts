// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import BrowserControlSurfaceView from '../../src/renderer/components/browser/BrowserControlSurface.vue';
import { browserControlDialogLabels } from '../../src/renderer/lib/browserControlPresentation';
import type { BrowserControlDialogs, BrowserControlSurface, BrowserControlSurfaceBridge } from '../../src/shared/browser-control';
import type { BrowserDialogRecord } from '../../src/shared/browser-dialogs';

const i18n = createKimiI18n({ locale: 'en' });
const t = (key: string, params?: Record<string, string>) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));
const labels: BrowserControlSurface['labels'] = {
  running: 'Agent is in control', elapsed: '{time}', takeover: 'Take over', takeoverHint: 'Stop', pointer: 'Agent', typing: 'Typing', key: 'Keys', scrolling: 'Scrolling',
  activityTarget: '{activity} “{target}”',
  activities: { reading: 'Reading', inspecting: 'Inspecting', capturing: 'Capturing', clicking: 'Clicking', hovering: 'Hovering', typing: 'Typing', pressing: 'Pressing', selecting: 'Selecting', checking: 'Checking', scrolling: 'Scrolling', dragging: 'Dragging', navigating: 'Opening page', waiting: 'Waiting', answering: 'Answering' },
  dialogs: browserControlDialogLabels(t),
};
const PATH = '/Users/me/Downloads/BaiduNetdisk_mac_8.8.8_arm64.dmg';

let app: App | null = null;
let host: HTMLDivElement;
let emitSurface: (surface: BrowserControlSurface | null) => void;
let emitDialogs: (dialogs: BrowserControlDialogs) => void;
const downloadAction = vi.fn();

function record(id: number, patch: Partial<BrowserDialogRecord> = {}): BrowserDialogRecord {
  return { id: `record-${id}`, kind: 'confirm', origin: 'https://example.test', outcome: 'accepted', answerer: 'agent', openedAt: id * 1_000, settledAt: id * 1_000 + 10, ...patch };
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  const bridge: BrowserControlSurfaceBridge = {
    ready: () => {}, takeOver: () => {}, downloadAction,
    onDialogs: (cb) => { emitDialogs = cb; return () => {}; },
    onSurface: (cb) => { emitSurface = cb; return () => {}; },
    onPointer: () => () => {},
    onActivity: () => () => {},
    onResizing: () => () => {},
  };
  (window as { kimiBrowserControl?: BrowserControlSurfaceBridge }).kimiBrowserControl = bridge;
  app = createApp(BrowserControlSurfaceView);
  app.mount(host);
  emitSurface({ browserId: 'page', revision: 3, startedAt: Date.now(), labels, colorScheme: 'light', reducedMotion: false, corners: [0, 0, 0, 0], insets: [0, 0, 0, 0] });
  await nextTick();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  downloadAction.mockClear();
});

const badge = () => host.querySelector('.control-records-badge')?.textContent;
const button = () => host.querySelector<HTMLButtonElement>('.control-records-button button');

it('shows the notification button only once something was handled, with an unseen count', async () => {
  expect(button()).toBeNull();
  emitDialogs({ browserId: 'page', revision: 3, records: [record(1)] });
  await nextTick();
  expect(button()?.getAttribute('aria-label')).toBe('Handled page dialogs');
  expect(badge()).toBe('1');
  emitDialogs({ browserId: 'page', revision: 3, records: [record(1), record(2, { kind: 'download', outcome: 'saved', answerer: 'auto', files: [PATH], downloadId: 'download-1' })] });
  await nextTick();
  expect(badge()).toBe('2');
  emitDialogs({ browserId: 'page', revision: 2, records: [] });
  emitDialogs({ browserId: 'other', revision: 3, records: [] });
  await nextTick();
  expect(badge()).toBe('2');
});

it('lists records newest first with who answered, wrapped paths and download actions', async () => {
  emitDialogs({ browserId: 'page', revision: 3, records: [
    record(1, { kind: 'alert', message: 'Saved!' }),
    record(2, { kind: 'download', outcome: 'saved', answerer: 'auto', message: 'BaiduNetdisk_mac_8.8.8_arm64.dmg', files: [PATH], downloadId: 'download-1' }),
  ] });
  await nextTick();
  button()!.click();
  await nextTick();
  expect(badge()).toBeUndefined();
  const rows = [...host.querySelectorAll('.control-record')];
  expect(rows.map(row => row.querySelector('.control-record-title span')?.textContent)).toEqual(['Download', 'Alert']);
  expect(rows[0]!.querySelector('.control-record-answer')?.textContent).toBe('Saved automatically');
  expect(rows[1]!.querySelector('.control-record-answer')?.textContent).toBe('Accepted by the agent');
  expect(rows[0]!.querySelector('.control-record-path')?.textContent).toBe(PATH);
  const actions = [...rows[0]!.querySelectorAll<HTMLButtonElement>('.control-record-actions button')];
  expect(actions.map(action => action.textContent?.trim())).toEqual(['Show in folder', 'Move…']);
  actions[0]!.click();
  actions[1]!.click();
  expect(downloadAction.mock.calls).toEqual([
    [{ browserId: 'page', revision: 3, recordId: 'record-2', action: 'show' }],
    [{ browserId: 'page', revision: 3, recordId: 'record-2', action: 'move' }],
  ]);
  expect(rows[1]!.querySelector('.control-record-actions')).toBeNull();
});

it('clears the records when a new control session starts', async () => {
  emitDialogs({ browserId: 'page', revision: 3, records: [record(1)] });
  await nextTick();
  emitSurface({ browserId: 'page', revision: 4, startedAt: Date.now(), labels, colorScheme: 'light', reducedMotion: false, corners: [0, 0, 0, 0], insets: [0, 0, 0, 0] });
  await nextTick();
  expect(button()).toBeNull();
});
