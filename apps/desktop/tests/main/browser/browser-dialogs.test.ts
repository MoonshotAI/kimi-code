import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answeringBrowserDialog,
  cancelBrowserDialog,
  cancelBrowserDialogs,
  configureBrowserDialogs,
  discardBrowserDialogs,
  forgetBrowserEvents,
  blockingBrowserDialogs,
  hasBlockingBrowserDialog,
  hasPendingBrowserEvents,
  listBrowserDialogHistory,
  listBrowserDialogs,
  listPendingBrowserDialogs,
  onBrowserDialogHistory,
  recordBrowserDialogEvent,
  syncBrowserDialogControl,
  takeBrowserDialogRecords,
  takeBrowserDialogReminder,
  hasQueuedBrowserEvents,
  updateBrowserDownloadRecord,
  onBrowserDialogOpened,
  openBrowserDialog,
  pushAgentBrowserNotice,
  pushBrowserNotice,
  resetBrowserDialogsForTest,
  respondBrowserDialog,
  takeBrowserNotices,
  publishBrowserDialogs,
} from '../../../src/main/browser/browser-dialogs';

const controlled = new Set<string>();
const publish = vi.fn();

beforeEach(() => {
  resetBrowserDialogsForTest();
  controlled.clear();
  publish.mockClear();
  configureBrowserDialogs({ isAgentControlled: browserId => controlled.has(browserId), publish });
});

afterEach(() => {
  vi.useRealTimers();
  configureBrowserDialogs({ isAgentControlled: () => false, controlSession: () => undefined, publish: () => {} });
});

describe('browser dialog broker', () => {
  it('lists an open dialog, publishes it and settles it once with the answer', async () => {
    const onAnswer = vi.fn();
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: 'https://example.test', message: 'Delete?', onAnswer })!;
    expect(listBrowserDialogs('browser-1')).toEqual([{ dialogId, browserId: 'browser-1', kind: 'confirm', origin: 'https://example.test', message: 'Delete?', answerer: 'user' }]);
    expect(listBrowserDialogs('browser-2')).toEqual([]);
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ dialogId })]);
    expect(hasBlockingBrowserDialog('browser-1')).toBe(true);
    await expect(respondBrowserDialog(dialogId, { accept: true }, 'user')).resolves.toBe('answered');
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ accept: true, by: 'user' });
    expect(listBrowserDialogs()).toEqual([]);
    expect(publish).toHaveBeenLastCalledWith([]);
    await expect(respondBrowserDialog(dialogId, { accept: false }, 'user')).resolves.toBe('not-found');
    expect(onAnswer).toHaveBeenCalledOnce();
  });

  it('marks who is answering from the current control of the tab', () => {
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', onAnswer: vi.fn() });
    expect(listBrowserDialogs('browser-1')[0]!.answerer).toBe('user');
    controlled.add('browser-1');
    expect(listBrowserDialogs('browser-1')[0]!.answerer).toBe('agent');
    openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: '', files: ['/tmp/a.txt'], userOnly: true, onAnswer: vi.fn() });
    expect(listBrowserDialogs('browser-1').map(dialog => dialog.answerer)).toEqual(['agent', 'user']);
  });

  it('keeps user-only dialogs away from the agent', async () => {
    const onAnswer = vi.fn();
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: '', userOnly: true, onAnswer })!;
    await expect(respondBrowserDialog(dialogId, { accept: true }, 'agent')).resolves.toBe('user-only');
    expect(onAnswer).not.toHaveBeenCalled();
    await expect(respondBrowserDialog(dialogId, { accept: false }, 'user')).resolves.toBe('answered');
    expect(onAnswer).toHaveBeenCalledWith({ accept: false, by: 'user' });
  });

  it('cancels with a null answer, by id or by filter, and discards silently', () => {
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const owner = {};
    const firstId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: '', owner, onAnswer: first })!;
    openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: '', owner, onAnswer: second });
    openBrowserDialog({ browserId: 'browser-2', kind: 'alert', origin: '', onAnswer: third });
    expect(cancelBrowserDialog(firstId)).toBe(true);
    expect(cancelBrowserDialog(firstId)).toBe(false);
    expect(first).toHaveBeenCalledExactlyOnceWith(null);
    expect(cancelBrowserDialogs({ owner, kinds: ['beforeunload'] })).toBe(1);
    expect(second).toHaveBeenCalledExactlyOnceWith(null);
    discardBrowserDialogs({ browserId: 'browser-2' });
    expect(third).not.toHaveBeenCalled();
    expect(listBrowserDialogs()).toEqual([]);
  });

  it('times out a dialog as a cancellation', () => {
    vi.useFakeTimers();
    const onAnswer = vi.fn();
    openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: '', timeoutMs: 1_000, onAnswer });
    vi.advanceTimersByTime(999);
    expect(listBrowserDialogs()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(null);
    expect(listBrowserDialogs()).toEqual([]);
  });

  it('notifies open listeners for their tab until they unsubscribe', () => {
    const listener = vi.fn();
    const off = onBrowserDialogOpened('browser-1', listener);
    openBrowserDialog({ browserId: 'browser-2', kind: 'alert', origin: '', onAnswer: vi.fn() });
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'Hi', onAnswer: vi.fn() });
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'alert', message: 'Hi' }));
    off();
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', onAnswer: vi.fn() });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('bounds long page messages', () => {
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'x'.repeat(10_000), onAnswer: vi.fn() });
    expect(listBrowserDialogs()[0]!.message.length).toBeLessThanOrEqual(4096);
  });

  it('queues notices per tab, drops repeats and only records agent notices under agent control', () => {
    pushBrowserNotice('browser-1', 'one');
    pushBrowserNotice('browser-1', 'one');
    pushAgentBrowserNotice('browser-1', 'ignored');
    controlled.add('browser-1');
    pushAgentBrowserNotice('browser-1', 'two');
    pushAgentBrowserNotice(undefined, 'lost');
    expect(takeBrowserNotices('browser-1')).toEqual(['one', 'two']);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
  });
});

describe('handled dialog history', () => {
  let session: string | undefined;

  beforeEach(() => {
    session = 'session-1:turn-1';
    configureBrowserDialogs({ controlSession: () => session });
  });

  it('gives records ids that stay unique when a restarted process starts its sequence again', async () => {
    controlled.add('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'print', origin: 'https://a.test' });
    const [before] = takeBrowserDialogRecords('browser-1');
    vi.resetModules();
    const restarted = await import('../../../src/main/browser/browser-dialogs');
    restarted.configureBrowserDialogs({ isAgentControlled: () => true, controlSession: () => session, publish: () => {} });
    restarted.recordBrowserDialogEvent('browser-1', { kind: 'print', origin: 'https://a.test' });
    const [after] = restarted.takeBrowserDialogRecords('browser-1');
    expect(before!.id).toMatch(/^[A-Za-z0-9:_-]+$/);
    expect(after!.id).not.toBe(before!.id);
  });

  it('records a dialog settled while the agent controls the tab, with outcome, answerer and files', async () => {
    controlled.add('browser-1');
    const confirm = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: 'https://example.test', message: 'Delete?', onAnswer: vi.fn() })!;
    const leave = openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: 'https://example.test', onAnswer: vi.fn() })!;
    const file = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://example.test', onAnswer: vi.fn() })!;
    await respondBrowserDialog(confirm, { accept: false }, 'agent');
    await respondBrowserDialog(leave, { accept: true }, 'user');
    await respondBrowserDialog(file, { accept: true, files: ['/tmp/a.pdf'] }, 'agent');
    expect(listBrowserDialogHistory('browser-1')).toEqual([
      expect.objectContaining({ kind: 'confirm', origin: 'https://example.test', message: 'Delete?', outcome: 'dismissed', answerer: 'agent' }),
      expect.objectContaining({ kind: 'beforeunload', outcome: 'left', answerer: 'user' }),
      expect.objectContaining({ kind: 'file', outcome: 'uploaded', answerer: 'agent', files: ['/tmp/a.pdf'] }),
    ]);
    expect(listBrowserDialogHistory('browser-1')[0]!.settledAt).toBeGreaterThanOrEqual(listBrowserDialogHistory('browser-1')[0]!.openedAt);
  });

  it('records accepting a leave the app cannot replay as accepted, not as having left the page', async () => {
    controlled.add('browser-1');
    const form = openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: 'https://a.test', target: 'https://a.test/submit', repeat: 'form', onAnswer: vi.fn() })!;
    await respondBrowserDialog(form, { accept: true }, 'agent');
    const action = openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: 'https://a.test', repeat: 'action', onAnswer: vi.fn() })!;
    await respondBrowserDialog(action, { accept: true }, 'user');
    const replayed = openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: 'https://a.test', target: 'https://a.test/next', onAnswer: vi.fn() })!;
    await respondBrowserDialog(replayed, { accept: true }, 'agent');
    expect(listBrowserDialogHistory('browser-1').map(record => record.outcome)).toEqual(['accepted', 'accepted', 'left']);
  });

  it('does not count an app-only notice as a dialog blocking the page', () => {
    controlled.add('browser-1');
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: 'https://a.test', userOnly: true, message: 'Picker cancelled', onAnswer: vi.fn() });
    expect(hasBlockingBrowserDialog('browser-1')).toBe(false);
    expect(blockingBrowserDialogs('browser-1')).toEqual([]);
    const alert = openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: 'https://a.test', message: 'Hi', onAnswer: vi.fn() })!;
    expect(blockingBrowserDialogs('browser-1').map(dialog => dialog.dialogId)).toEqual([alert]);
  });

  it('reports a dialog settled after the last browser result of a turn once in the next turn', async () => {
    controlled.add('browser-1');
    syncBrowserDialogControl();
    const confirm = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: 'https://example.test', message: 'Delete?', onAnswer: vi.fn() })!;
    expect(takeBrowserDialogRecords('browser-1')).toEqual([]);
    await respondBrowserDialog(confirm, { accept: true }, 'user');
    controlled.delete('browser-1');
    syncBrowserDialogControl();
    session = 'session-1:turn-2';
    controlled.add('browser-1');
    syncBrowserDialogControl();
    const fits = { pending: <T>(dialog: T) => dialog, handled: () => true };
    const tabs = new Map([['browser-1', 'tab-1']]);
    expect(takeBrowserDialogReminder(tabs, fits).handledDialogs).toEqual([expect.objectContaining({ tabId: 'tab-1', kind: 'confirm', outcome: 'accepted', answerer: 'user' })]);
    expect(takeBrowserDialogRecords('browser-1')).toEqual([]);
    expect(takeBrowserDialogReminder(tabs, fits).handledDialogs).toEqual([]);
  });

  it('records a file answer only after the files are attached', async () => {
    controlled.add('browser-1');
    let attach!: () => void;
    let fail!: (error: Error) => void;
    const ok = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://example.test', onAnswer: () => new Promise<void>(resolve => { attach = resolve; }) })!;
    const answered = respondBrowserDialog(ok, { accept: true, files: ['/tmp/a.pdf'] }, 'agent');
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    attach();
    await expect(answered).resolves.toBe('answered');
    const broken = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://example.test', onAnswer: () => new Promise<void>((_, reject) => { fail = reject; }) })!;
    const failed = respondBrowserDialog(broken, { accept: true, files: ['/tmp/b.pdf'] }, 'agent');
    fail(new Error('node detached'));
    await expect(failed).rejects.toThrow('node detached');
    expect(listBrowserDialogHistory('browser-1').map(record => [record.kind, record.outcome, record.files])).toEqual([
      ['file', 'uploaded', ['/tmp/a.pdf']], ['file', 'cancelled', undefined],
    ]);
    expect(listBrowserDialogs('browser-1')).toEqual([]);
  });

  it('records timeouts, page cancellations and blocked actions as automatic', () => {
    vi.useFakeTimers();
    controlled.add('browser-1');
    openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', timeoutMs: 1_000, onAnswer: vi.fn() });
    const owner = {};
    openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: 'https://a.test', message: 'x'.repeat(5_000), owner, onAnswer: vi.fn() });
    vi.advanceTimersByTime(1_000);
    discardBrowserDialogs({ owner });
    pushAgentBrowserNotice('browser-1', 'mailto blocked', { kind: 'external-app', origin: 'https://a.test', message: 'mailto:a@b.test' });
    const history = listBrowserDialogHistory('browser-1');
    expect(history.map(record => [record.kind, record.outcome, record.answerer])).toEqual([
      ['file', 'timed-out', 'auto'], ['alert', 'cancelled', 'auto'], ['external-app', 'blocked', 'auto'],
    ]);
    expect(history[1]!.message!.length).toBeLessThanOrEqual(512);
  });

  it.each([[true, 'saved', ['/d/a.zip']], [false, 'cancelled', undefined]] as const)('treats an unanswered download notice timeout as keep and records the final outcome (completed %s)', async (completed, outcome, files) => {
    vi.useFakeTimers();
    controlled.add('browser-1');
    let finish!: (value: boolean) => void;
    const done = new Promise<boolean>(resolve => { finish = resolve; });
    const onAnswer = vi.fn();
    openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: 'https://a.test', message: 'a.zip', files: ['/d/a.zip'], userOnly: true, timeoutMs: 1_000, download: { id: 'download-1', done }, onAnswer });
    vi.advanceTimersByTime(1_000);
    expect(onAnswer).toHaveBeenCalledWith(null);
    expect(listBrowserDialogs()).toEqual([]);
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    finish(completed);
    await vi.waitFor(() => expect(listBrowserDialogHistory('browser-1')).toHaveLength(1));
    const [record] = listBrowserDialogHistory('browser-1');
    expect(record).toMatchObject({ kind: 'download', outcome, answerer: 'auto', downloadId: 'download-1' });
    expect(record!.files).toEqual(files);
  });

  it('keeps dialogs the agent never saw out of the history', async () => {
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', onAnswer: vi.fn() })!;
    await respondBrowserDialog(dialogId, { accept: true }, 'user');
    recordBrowserDialogEvent('browser-1', { kind: 'print', origin: '' });
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
  });

  it('records a dialog opened before control ended and answered by the user afterwards', async () => {
    controlled.add('browser-1');
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: '', onAnswer: vi.fn() })!;
    controlled.delete('browser-1');
    session = undefined;
    syncBrowserDialogControl();
    await respondBrowserDialog(dialogId, { accept: true }, 'user');
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    controlled.add('browser-1');
    session = 'session-1:turn-2';
    syncBrowserDialogControl();
    expect(listBrowserDialogHistory('browser-1')).toEqual([expect.objectContaining({ outcome: 'accepted', answerer: 'user' })]);
  });

  it('gives the agent the text the user typed into a prompt opened on an agent-controlled tab', async () => {
    controlled.add('browser-1');
    const prompt = openBrowserDialog({ browserId: 'browser-1', kind: 'prompt', origin: 'https://a.test', message: 'Name?', defaultValue: 'Ada', onAnswer: vi.fn() })!;
    await respondBrowserDialog(prompt, { accept: true, text: 'Grace' }, 'user');
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ kind: 'prompt', outcome: 'accepted', answerer: 'user', text: 'Grace' })]);
  });

  it('only tells the agent that the user answered a prompt opened on the user tab', async () => {
    const prompt = openBrowserDialog({ browserId: 'browser-1', kind: 'prompt', origin: 'https://a.test', message: 'Name?', onAnswer: vi.fn() })!;
    controlled.add('browser-1');
    syncBrowserDialogControl();
    controlled.delete('browser-1');
    session = undefined;
    syncBrowserDialogControl();
    await respondBrowserDialog(prompt, { accept: true, text: 'secret' }, 'user');
    controlled.add('browser-1');
    session = 'session-1:turn-2';
    syncBrowserDialogControl();
    const [record] = takeBrowserDialogRecords('browser-1');
    expect(record).toMatchObject({ kind: 'prompt', outcome: 'accepted', answerer: 'user' });
    expect(record).not.toHaveProperty('text');
  });

  it('caps the history and keeps the newest records', () => {
    controlled.add('browser-1');
    for (let index = 0; index < 60; index++) recordBrowserDialogEvent('browser-1', { kind: 'print', origin: `https://${index}.test` });
    const history = listBrowserDialogHistory('browser-1');
    expect(history).toHaveLength(50);
    expect(history[0]!.origin).toBe('https://10.test');
    expect(history.at(-1)!.origin).toBe('https://59.test');
  });

  it('keeps the last session until the next control session starts, then clears it', () => {
    const changed = vi.fn();
    const off = onBrowserDialogHistory(changed);
    controlled.add('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'print', origin: '' });
    controlled.delete('browser-1');
    session = undefined;
    syncBrowserDialogControl();
    expect(listBrowserDialogHistory('browser-1')).toHaveLength(1);
    controlled.add('browser-1');
    session = 'session-1:turn-1';
    syncBrowserDialogControl();
    expect(listBrowserDialogHistory('browser-1')).toHaveLength(1);
    session = 'session-1:turn-2';
    syncBrowserDialogControl();
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    expect(changed).toHaveBeenLastCalledWith('browser-1');
    off();
  });

  it('keeps records that do not fit the output budget queued in order', () => {
    controlled.add('browser-1');
    for (const name of ['a', 'b', 'c']) recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: `${name}.zip`, outcome: 'saved', files: Array.from({ length: 20 }, (_, index) => `/d/${name}${index}.zip`), downloadId: `download-${name}` });
    let budget = 1;
    const first = takeBrowserDialogRecords('browser-1', () => budget-- > 0);
    expect(first.map(record => record.message)).toEqual(['a.zip']);
    expect(first[0]!.files).toHaveLength(8);
    expect(hasQueuedBrowserEvents('browser-1')).toBe(true);
    expect(takeBrowserDialogRecords('browser-1').map(record => record.message)).toEqual(['b.zip', 'c.zip']);
    expect(hasQueuedBrowserEvents('browser-1')).toBe(false);
  });

  it('delivers each record once to the next browser result and again after an update', () => {
    controlled.add('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: 'a.zip', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' });
    expect(hasPendingBrowserEvents()).toBe(true);
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ kind: 'download', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' })]);
    expect(takeBrowserDialogRecords('browser-1')).toEqual([]);
    expect(hasPendingBrowserEvents()).toBe(false);
    expect(updateBrowserDownloadRecord('download-1', { path: null, outcome: 'too-large' })).toBe(true);
    const [updated] = takeBrowserDialogRecords('browser-1');
    expect(updated).toMatchObject({ outcome: 'too-large' });
    expect(updated).not.toHaveProperty('files');
    expect(listBrowserDialogHistory('browser-1')).toHaveLength(1);
  });

  it('keeps a deferred event from an uncontrolled tab for the next control session', () => {
    session = 'session-1:turn-1';
    controlled.add('browser-1');
    syncBrowserDialogControl();
    controlled.delete('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'print', origin: '' });
    recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: 'a.zip', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' }, { deferred: true });
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    expect(hasPendingBrowserEvents()).toBe(true);
    controlled.add('browser-1');
    session = 'session-1:turn-2';
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ kind: 'download', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' })]);
    expect(listBrowserDialogHistory('browser-1')).toHaveLength(1);
    expect(hasPendingBrowserEvents()).toBe(false);
  });

  it('moves a deferred download record to its new path before the next control session takes it', () => {
    session = 'session-1:turn-1';
    controlled.add('browser-1');
    syncBrowserDialogControl();
    controlled.delete('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: 'a.zip', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' }, { deferred: true });
    expect(updateBrowserDownloadRecord('download-1', { path: '/moved/a.zip' })).toBe(true);
    controlled.add('browser-1');
    session = 'session-1:turn-2';
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ downloadId: 'download-1', files: ['/moved/a.zip'] })]);
    expect(listBrowserDialogHistory('browser-1')).toEqual([expect.objectContaining({ downloadId: 'download-1', files: ['/moved/a.zip'] })]);
  });

  it('moves a carried download record to its new path before the next control session takes it', () => {
    session = 'session-1:turn-1';
    controlled.add('browser-1');
    recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: 'a.zip', outcome: 'saved', files: ['/d/a.zip'], downloadId: 'download-1' });
    session = 'session-2:turn-1';
    syncBrowserDialogControl();
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    expect(updateBrowserDownloadRecord('download-1', { path: '/moved/a.zip' })).toBe(true);
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ downloadId: 'download-1', files: ['/moved/a.zip'] })]);
  });

  it('queues a dialog the user settles between control sessions for the next one', async () => {
    controlled.add('browser-1');
    syncBrowserDialogControl();
    const upload = openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', files: ['/x/a.txt'], userOnly: true, onAnswer: vi.fn() })!;
    expect(takeBrowserDialogRecords('browser-1')).toEqual([]);
    controlled.delete('browser-1');
    session = undefined;
    syncBrowserDialogControl();
    await respondBrowserDialog(upload, { accept: true }, 'user');
    expect(hasPendingBrowserEvents()).toBe(true);
    controlled.add('browser-1');
    session = 'session-1:turn-2';
    syncBrowserDialogControl();
    expect(takeBrowserDialogRecords('browser-1')).toEqual([expect.objectContaining({ kind: 'upload', outcome: 'accepted', answerer: 'user', files: ['/x/a.txt'] })]);
    expect(hasPendingBrowserEvents()).toBe(false);
  });

  it('drops events, settlements and notices for a tab that is no longer open', async () => {
    const open = new Set(['browser-1']);
    configureBrowserDialogs({ isBrowserOpen: browserId => open.has(browserId) });
    try {
      controlled.add('browser-1');
      const confirm = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: 'https://a.test', onAnswer: vi.fn() })!;
      controlled.delete('browser-1');
      open.delete('browser-1');
      forgetBrowserEvents('browser-1');
      await respondBrowserDialog(confirm, { accept: true }, 'user');
      recordBrowserDialogEvent('browser-1', { kind: 'download', origin: 'https://a.test', message: 'a.zip', outcome: 'saved', downloadId: 'download-1' }, { deferred: true });
      pushBrowserNotice('browser-1', 'Download finished.');
      expect(hasPendingBrowserEvents()).toBe(false);
    } finally {
      configureBrowserDialogs({ isBrowserOpen: () => true });
    }
  });

  it('cancels a linked approval together with the dialog it answers', async () => {
    const owner = {};
    const parentAnswer = vi.fn();
    const childAnswer = vi.fn();
    const parentId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', owner, onAnswer: parentAnswer })!;
    openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', files: ['/x/a.txt'], parentDialogId: parentId, userOnly: true, onAnswer: childAnswer });
    expect(listBrowserDialogs('browser-1').map(dialog => dialog.kind)).toEqual(['file', 'upload']);
    discardBrowserDialogs({ owner, kinds: ['upload'] });
    expect(listBrowserDialogs('browser-1').map(dialog => dialog.kind)).toEqual(['file']);
    openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', files: ['/x/a.txt'], parentDialogId: parentId, userOnly: true, onAnswer: childAnswer });
    cancelBrowserDialog(parentId);
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(childAnswer).toHaveBeenCalledWith(null);
    const orphan = vi.fn();
    expect(openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', parentDialogId: parentId, userOnly: true, onAnswer: orphan })).toBeNull();
    expect(orphan).toHaveBeenCalledWith(null);
    await Promise.resolve();
  });

  it('keeps a file dialog the user is answering out of the lists and gating the tab until the files are attached', async () => {
    vi.useFakeTimers();
    controlled.add('browser-1');
    let attach!: () => void;
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', timeoutMs: 1000, onAnswer: () => new Promise<void>(resolve => { attach = resolve; }) })!;
    const answered = respondBrowserDialog(dialogId, { accept: true, files: ['/x/a.txt'] }, 'user');
    expect(answeringBrowserDialog('browser-1')).toEqual({ dialogId, kind: 'file', by: 'user' });
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(listPendingBrowserDialogs(new Map([['browser-1', 'tab-1']]))).toEqual([]);
    await expect(respondBrowserDialog(dialogId, { accept: false }, 'agent')).resolves.toBe('not-found');
    vi.advanceTimersByTime(2000);
    expect(answeringBrowserDialog('browser-1')).toBeDefined();
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
    attach();
    await expect(answered).resolves.toBe('answered');
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
    expect(listBrowserDialogHistory('browser-1').map(record => [record.outcome, record.files])).toEqual([['uploaded', ['/x/a.txt']]]);
  });

  it('lets a download move wait in the background without gating the tab', async () => {
    controlled.add('browser-1');
    let moved!: () => void;
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: 'https://a.test', message: 'a.zip', files: ['/d/a.zip'], userOnly: true, onAnswer: () => new Promise<void>(resolve => { moved = resolve; }) })!;
    const answered = respondBrowserDialog(dialogId, { accept: true, files: ['/m/a.zip'] }, 'user');
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
    moved();
    await expect(answered).resolves.toBe('answered');
  });

  it('reports a user answer on an agent-controlled tab', async () => {
    controlled.add('browser-1');
    const onUserAnswer = vi.fn();
    configureBrowserDialogs({ onUserAnswer });
    try {
      const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: 'https://a.test', message: 'Go?', onAnswer: vi.fn() })!;
      await respondBrowserDialog(dialogId, { accept: true }, 'user');
      expect(onUserAnswer).toHaveBeenCalledExactlyOnceWith('browser-1');
    } finally { configureBrowserDialogs({ onUserAnswer: () => {} }); }
  });

  it('does not report a user answer for a download notice', async () => {
    controlled.add('browser-1');
    const onUserAnswer = vi.fn();
    configureBrowserDialogs({ onUserAnswer });
    try {
      for (const accept of [true, false]) {
        const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: 'https://a.test', message: 'a.zip', files: ['/d/a.zip'], userOnly: true, onAnswer: vi.fn() })!;
        await expect(respondBrowserDialog(dialogId, { accept }, 'user')).resolves.toBe('answered');
      }
      expect(onUserAnswer).not.toHaveBeenCalled();
    } finally { configureBrowserDialogs({ onUserAnswer: () => {} }); }
  });

  it('reports a failed attach to the agent as a cancelled record and a notice', async () => {
    controlled.add('browser-1');
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', onAnswer: () => Promise.reject(new Error('node detached')) })!;
    await expect(respondBrowserDialog(dialogId, { accept: true }, 'user')).rejects.toThrow('node detached');
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
    expect(listBrowserDialogHistory('browser-1').map(record => record.outcome)).toEqual(['cancelled']);
    expect(takeBrowserNotices('browser-1')).toEqual([expect.stringContaining('node detached')]);
  });

  it('cleans up a dialog that closes while it is being answered and ignores the late result', async () => {
    controlled.add('browser-1');
    const owner = {};
    let attach!: () => void;
    const onAnswer = vi.fn(() => new Promise<void>(resolve => { attach = resolve; }));
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', owner, onAnswer })!;
    const answered = respondBrowserDialog(dialogId, { accept: true, files: ['/x/a.txt'] }, 'user');
    discardBrowserDialogs({ owner });
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
    attach();
    await expect(answered).resolves.toBe('answered');
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(listBrowserDialogHistory('browser-1').map(record => record.outcome)).toEqual(['cancelled']);
    const second = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', onAnswer: () => new Promise<void>(() => {}) })!;
    void respondBrowserDialog(second, { accept: true }, 'user');
    expect(cancelBrowserDialog(second)).toBe(true);
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
  });

  it('attaches an approved upload without cancelling the approval that answers it', async () => {
    controlled.add('browser-1');
    let attach!: () => void;
    const parentId = openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', onAnswer: () => new Promise<void>(resolve => { attach = resolve; }) })!;
    const childAnswer = vi.fn(async () => { await respondBrowserDialog(parentId, { accept: true, files: ['/x/a.txt'] }, 'agent'); });
    const childId = openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', files: ['/x/a.txt'], parentDialogId: parentId, userOnly: true, onAnswer: childAnswer })!;
    const approved = respondBrowserDialog(childId, { accept: true }, 'user');
    expect(answeringBrowserDialog('browser-1')).toBeDefined();
    expect(openBrowserDialog({ browserId: 'browser-1', kind: 'upload', origin: 'https://a.test', parentDialogId: parentId, userOnly: true, onAnswer: vi.fn() })).toBeNull();
    attach();
    await expect(approved).resolves.toBe('answered');
    expect(answeringBrowserDialog('browser-1')).toBeUndefined();
    expect(listBrowserDialogHistory('browser-1').map(record => [record.kind, record.outcome])).toEqual([['file', 'uploaded'], ['upload', 'accepted']]);
  });

  it('forgets the notices and history of a closed tab', () => {
    controlled.add('browser-1');
    pushAgentBrowserNotice('browser-1', 'Blocked.', { kind: 'print', origin: 'https://a.test' });
    expect(hasPendingBrowserEvents()).toBe(true);
    forgetBrowserEvents('browser-1');
    expect(hasPendingBrowserEvents()).toBe(false);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
    expect(listBrowserDialogHistory('browser-1')).toEqual([]);
  });
});

describe('agent answerability', () => {
  it('recomputes the answerer when control changes and republishes it', () => {
    controlled.add('browser-1');
    openBrowserDialog({ browserId: 'browser-1', kind: 'confirm', origin: '', onAnswer: vi.fn() });
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ answerer: 'agent' })]);
    controlled.delete('browser-1');
    syncBrowserDialogControl();
    publishBrowserDialogs();
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ answerer: 'user' })]);
    expect(listPendingBrowserDialogs(new Map([['browser-1', 'tab-1']]))).toEqual([expect.objectContaining({ tabId: 'tab-1', answerer: 'user' })]);
  });

  it('briefly republishes the agent choice after the agent answers and never auto-answers', async () => {
    vi.useFakeTimers();
    controlled.add('browser-1');
    const onAnswer = vi.fn();
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'Hi', onAnswer })!;
    vi.advanceTimersByTime(60_000);
    expect(onAnswer).not.toHaveBeenCalled();
    await respondBrowserDialog(dialogId, { accept: true }, 'agent');
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ dialogId, agentChoice: 'accepted' })]);
    expect(listBrowserDialogs()).toEqual([]);
    vi.advanceTimersByTime(900);
    expect(publish).toHaveBeenLastCalledWith([]);
  });

  it('shows an alert the agent dismissed as accepted', async () => {
    controlled.add('browser-1');
    const dialogId = openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'Hi', onAnswer: vi.fn() })!;
    await respondBrowserDialog(dialogId, { accept: false }, 'agent');
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ dialogId, agentChoice: 'accepted' })]);
  });

  it('keeps the published list within the IPC limit while agent choices linger', async () => {
    vi.useFakeTimers();
    controlled.add('browser-1');
    const ids = Array.from({ length: 64 }, () => openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'Hi', onAnswer: vi.fn() })!);
    await respondBrowserDialog(ids[0]!, { accept: true }, 'agent');
    const fresh = openBrowserDialog({ browserId: 'browser-1', kind: 'alert', origin: '', message: 'New', onAnswer: vi.fn() })!;
    const published = publish.mock.lastCall![0] as { dialogId: string }[];
    expect(published).toHaveLength(64);
    expect(published.map(dialog => dialog.dialogId)).toContain(fresh);
    expect(published.map(dialog => dialog.dialogId)).not.toContain(ids[0]);
  });

  it('keeps room for blocking dialogs when download notices pile up', () => {
    const kept = vi.fn();
    const notices = Array.from({ length: 64 }, (_, index) => {
      const onAnswer = vi.fn();
      return { onAnswer, id: openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: '', message: `${index}.zip`, userOnly: true, onAnswer }) };
    });
    expect(notices.every(notice => notice.id !== null)).toBe(true);
    expect(listBrowserDialogs().filter(dialog => dialog.kind === 'download')).toHaveLength(16);
    expect(notices.slice(0, 48).every(notice => notice.onAnswer.mock.calls.length === 1 && notice.onAnswer.mock.calls[0]![0] === null)).toBe(true);
    expect(notices.slice(48).every(notice => notice.onAnswer.mock.calls.length === 0)).toBe(true);
    const alerts = Array.from({ length: 64 }, () => openBrowserDialog({ browserId: 'browser-2', kind: 'confirm', origin: '', message: 'Sure?', onAnswer: kept }));
    expect(alerts.every(id => id !== null)).toBe(true);
    expect(kept).not.toHaveBeenCalled();
    expect(listBrowserDialogs().filter(dialog => dialog.kind === 'download')).toHaveLength(0);
    expect(listBrowserDialogs()).toHaveLength(64);
    expect(openBrowserDialog({ browserId: 'browser-2', kind: 'confirm', origin: '', message: 'Over', onAnswer: kept })).toBeNull();
    expect(kept).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('counts downloads that are still being moved against the download notice cap', async () => {
    const moving = Array.from({ length: 64 }, (_, index) => {
      let finish = (): void => {};
      const moved = new Promise<undefined>((resolve) => { finish = () => resolve(undefined); });
      const id = openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: '', message: `${index}.zip`, userOnly: true, onAnswer: answer => answer === null ? undefined : moved });
      const answered = id === null ? undefined : respondBrowserDialog(id, { accept: true }, 'user');
      return { id, finish, answered };
    });
    expect(moving.slice(0, 16).every(item => item.id !== null)).toBe(true);
    expect(moving.slice(16).every(item => item.id === null)).toBe(true);
    const kept = vi.fn();
    const blocking = Array.from({ length: 48 }, () => openBrowserDialog({ browserId: 'browser-2', kind: 'confirm', origin: '', message: 'Sure?', onAnswer: kept }));
    expect(blocking.every(id => id !== null)).toBe(true);
    expect(kept).not.toHaveBeenCalled();
    for (const item of moving) item.finish();
    await Promise.all(moving.map(item => item.answered));
    expect(openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: '', message: 'next.zip', userOnly: true, onAnswer: vi.fn() })).not.toBeNull();
  });

  it('marks beforeunload dialogs the app cannot replay as needing a retry after accepting', () => {
    openBrowserDialog({ browserId: 'browser-1', kind: 'beforeunload', origin: 'https://a.test', target: 'https://a.test/submit', repeat: 'form', onAnswer: vi.fn() });
    openBrowserDialog({ browserId: 'browser-2', kind: 'beforeunload', origin: 'https://b.test', target: 'https://b.test/next', onAnswer: vi.fn() });
    const pending = listPendingBrowserDialogs(new Map([['browser-1', 'tab-1'], ['browser-2', 'tab-2']]));
    expect(pending.find(item => item.tabId === 'tab-1')).toMatchObject({ kind: 'beforeunload', retryAfterAccept: true });
    expect(pending.find(item => item.tabId === 'tab-2')).not.toHaveProperty('retryAfterAccept');
  });

  it('lists pending dialogs for known tabs with age and file details', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    openBrowserDialog({ browserId: 'browser-1', kind: 'file', origin: 'https://a.test', accept: ['.pdf'], multiple: true, onAnswer: vi.fn() });
    openBrowserDialog({ browserId: 'browser-2', kind: 'alert', origin: '', onAnswer: vi.fn() });
    openBrowserDialog({ browserId: 'browser-1', kind: 'download', origin: '', userOnly: true, onAnswer: vi.fn() });
    vi.setSystemTime(3_500);
    expect(listPendingBrowserDialogs(new Map([['browser-1', 'tab-1']]))).toEqual([
      { dialogId: expect.any(String), tabId: 'tab-1', kind: 'file', origin: 'https://a.test', message: '', answerer: 'user', accept: ['.pdf'], multiple: true, ageMs: 2_500 },
    ]);
  });
});
