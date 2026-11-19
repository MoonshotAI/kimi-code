import { randomUUID } from 'node:crypto';
import {
  BROWSER_DIALOG_HISTORY_MAX,
  BROWSER_DIALOG_RECORD_MESSAGE_MAX,
  BROWSER_PAGE_DIALOG_FILES_MAX,
  BROWSER_PAGE_DIALOG_MESSAGE_MAX,
  BROWSER_PAGE_DIALOG_TEXT_MAX,
  type BrowserDialogRecord,
  type BrowserDialogRecordKind,
  type BrowserDialogRecordOutcome,
  type BrowserPageDialog,
  type BrowserPageDialogKind,
  type BrowserPendingDialog,
} from '../../shared/browser-dialogs';

export type BrowserDialogAnswerer = 'agent' | 'user';

export interface BrowserDialogResponse {
  accept: boolean;
  files?: string[];
  text?: string;
}

export interface BrowserDialogAnswer extends BrowserDialogResponse {
  by: BrowserDialogAnswerer;
}

export interface BrowserDialogInput {
  browserId: string;
  kind: BrowserPageDialogKind;
  origin: string;
  message?: string;
  defaultValue?: string;
  accept?: string[];
  multiple?: boolean;
  files?: string[];
  target?: string;
  repeat?: 'form' | 'action';
  owner?: object;
  parentDialogId?: string;
  userOnly?: boolean;
  timeoutMs?: number;
  download?: { id: string; done: Promise<boolean> };
  onAnswer: (answer: BrowserDialogAnswer | null) => void | BrowserDialogAnswer | Promise<void | BrowserDialogAnswer>;
}

export type BrowserDialogRespondOutcome = 'answered' | 'not-found' | 'user-only';

export interface BrowserDialogEvent {
  kind: BrowserDialogRecordKind;
  origin: string;
  message?: string;
  outcome?: BrowserDialogRecordOutcome;
  files?: string[];
  downloadId?: string;
}

interface Entry {
  dialog: Omit<BrowserPageDialog, 'answerer'>;
  owner: object | undefined;
  parent: string | undefined;
  userOnly: boolean;
  onAnswer: BrowserDialogInput['onAnswer'];
  timer: ReturnType<typeof setTimeout> | undefined;
  openedAt: number;
  agentSeen: boolean;
  openedControlled: boolean;
  reminded: boolean;
  download: BrowserDialogInput['download'];
  answering: BrowserDialogAnswerer | undefined;
}

interface History {
  session: string | undefined;
  records: { seq: number; record: BrowserDialogRecord; reminded?: true }[];
  delivered: number;
}

type SettleReason = 'answered' | 'timeout' | 'cancelled';

const MAX_DIALOGS = 64;
const MAX_DOWNLOAD_NOTICES = 16;
const MAX_NOTICES = 16;
const MAX_HISTORY_BROWSERS = 64;
const NOTICE_MAX = 1024;
const PENDING_MESSAGE_MAX = 1024;
const PENDING_LIST_MAX = 8;
const PENDING_ITEM_MAX = 256;
const AGENT_CHOICE_LINGER_MS = 900;
const AGENT_CHOICE_KINDS: ReadonlySet<BrowserPageDialogKind> = new Set(['alert', 'confirm', 'prompt', 'beforeunload', 'file']);
export const BROWSER_BLOCKING_DIALOG_KINDS: ReadonlySet<BrowserPageDialogKind> = new Set(['alert', 'confirm', 'prompt']);

const entries = new Map<string, Entry>();
const lingering = new Map<string, { dialog: BrowserPageDialog; timer: ReturnType<typeof setTimeout> }>();
const notices = new Map<string, string[]>();
const histories = new Map<string, History>();
const deferredEvents = new Map<string, Omit<BrowserDialogRecord, 'id'>[]>();
const carriedRecords = new Map<string, Omit<BrowserDialogRecord, 'id'>[]>();
const remindedRecords = new WeakSet<object>();
const historyListeners = new Set<(browserId: string) => void>();
const openListeners = new Map<string, Set<(dialog: BrowserPageDialog) => void>>();
let agentControls: (browserId: string) => boolean = () => false;
let controlSession: (browserId: string) => string | undefined = () => undefined;
let browserOpen: (browserId: string) => boolean = () => true;
let publisher: (dialogs: BrowserPageDialog[]) => void = () => {};
let userAnswered: (browserId: string) => void = () => {};
let recordSequence = 0;

export function configureBrowserDialogs(options: {
  isAgentControlled?: (browserId: string) => boolean;
  controlSession?: (browserId: string) => string | undefined;
  isBrowserOpen?: (browserId: string) => boolean;
  publish?: (dialogs: BrowserPageDialog[]) => void;
  onUserAnswer?: (browserId: string) => void;
}): void {
  if (options.onUserAnswer) userAnswered = options.onUserAnswer;
  if (options.isAgentControlled) agentControls = options.isAgentControlled;
  if (options.controlSession) controlSession = options.controlSession;
  if (options.isBrowserOpen) browserOpen = options.isBrowserOpen;
  if (options.publish) publisher = options.publish;
}

function clip(value: string, max = BROWSER_PAGE_DIALOG_MESSAGE_MAX): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function answererFor(entry: Entry): BrowserDialogAnswerer {
  return entry.userOnly || !agentControls(entry.dialog.browserId) ? 'user' : 'agent';
}

function project(entry: Entry): BrowserPageDialog {
  return { ...entry.dialog, answerer: answererFor(entry), ...(entry.dialog.accept ? { accept: [...entry.dialog.accept] } : {}), ...(entry.dialog.files ? { files: [...entry.dialog.files] } : {}) };
}

export function listBrowserDialogs(browserId?: string): BrowserPageDialog[] {
  return [...entries.values()].filter(entry => entry.answering === undefined && (browserId === undefined || entry.dialog.browserId === browserId)).map(project);
}

export function answeringBrowserDialog(browserId: string): { dialogId: string; kind: BrowserPageDialogKind; by: BrowserDialogAnswerer } | undefined {
  for (const entry of entries.values()) {
    if (entry.dialog.browserId === browserId && entry.answering !== undefined && entry.dialog.kind !== 'download') return { dialogId: entry.dialog.dialogId, kind: entry.dialog.kind, by: entry.answering };
  }
  return undefined;
}

export function listPendingBrowserDialogs(tabs: ReadonlyMap<string, string>, now = Date.now()): BrowserPendingDialog[] {
  const pending: BrowserPendingDialog[] = [];
  for (const entry of entries.values()) {
    const tabId = tabs.get(entry.dialog.browserId);
    if (tabId === undefined || entry.dialog.kind === 'download' || entry.answering !== undefined) continue;
    const { dialogId, kind, origin, message, defaultValue, accept, multiple, files, target, repeat } = entry.dialog;
    pending.push({
      dialogId, tabId, kind, origin: clip(origin, PENDING_ITEM_MAX), message: clip(message, PENDING_MESSAGE_MAX), answerer: answererFor(entry),
      ...(defaultValue === undefined ? {} : { defaultValue: clip(defaultValue, PENDING_MESSAGE_MAX) }),
      ...(accept === undefined ? {} : { accept: accept.slice(0, PENDING_LIST_MAX).map(item => clip(item, PENDING_ITEM_MAX)) }),
      ...(multiple === undefined ? {} : { multiple }),
      ...(files === undefined ? {} : { files: files.slice(0, PENDING_LIST_MAX).map(item => clip(item, PENDING_ITEM_MAX)) }),
      ...(target === undefined ? {} : { target: clip(target, PENDING_ITEM_MAX) }),
      ...(repeat === undefined ? {} : { retryAfterAccept: true as const }),
      ageMs: Math.max(0, now - entry.openedAt),
    });
  }
  return pending;
}

export function getBrowserDialog(dialogId: string): BrowserPageDialog | undefined {
  const entry = entries.get(dialogId);
  return entry === undefined || entry.answering !== undefined ? undefined : project(entry);
}

export function blockingBrowserDialogs(browserId: string): BrowserPageDialog[] {
  return [...entries.values()].filter(entry => entry.dialog.browserId === browserId && !entry.userOnly && BROWSER_BLOCKING_DIALOG_KINDS.has(entry.dialog.kind)).map(project);
}

export function hasBlockingBrowserDialog(browserId: string): boolean {
  return blockingBrowserDialogs(browserId).length > 0;
}

export function publishBrowserDialogs(): void {
  publisher([...listBrowserDialogs(), ...[...lingering.values()].map(item => item.dialog)].slice(0, MAX_DIALOGS));
}

function notifyHistory(browserId: string): void {
  for (const listener of Array.from(historyListeners)) listener(browserId);
}

function historyFor(browserId: string, create: boolean): History | undefined {
  const session = agentControls(browserId) ? controlSession(browserId) : undefined;
  let history = histories.get(browserId);
  if (history !== undefined && session !== undefined && history.session !== session) {
    const had = history.records.length > 0;
    const undelivered = history.records
      .filter(item => item.seq > history!.delivered && item.reminded === undefined)
      .sort((a, b) => a.seq - b.seq)
      .map(({ record: { id: _id, ...record } }) => record);
    if (undelivered.length > 0) carriedRecords.set(browserId, [...(carriedRecords.get(browserId) ?? []), ...undelivered].slice(-BROWSER_DIALOG_HISTORY_MAX));
    history.session = session;
    history.records = [];
    history.delivered = recordSequence;
    if (had) notifyHistory(browserId);
  }
  if (history === undefined && create) {
    history = { session, records: [], delivered: recordSequence };
    histories.set(browserId, history);
    while (histories.size > MAX_HISTORY_BROWSERS) histories.delete(histories.keys().next().value!);
  }
  return history;
}

function appendRecord(browserId: string, record: Omit<BrowserDialogRecord, 'id'>, reminded = false): void {
  const history = historyFor(browserId, true)!;
  const seq = ++recordSequence;
  history.records.push({ seq, record: { id: `record-${randomUUID()}`, ...record }, ...(reminded ? { reminded: true as const } : {}) });
  if (history.records.length > BROWSER_DIALOG_HISTORY_MAX) history.records.splice(0, history.records.length - BROWSER_DIALOG_HISTORY_MAX);
  notifyHistory(browserId);
}

function copyRecord(record: BrowserDialogRecord): BrowserDialogRecord {
  return { ...record, ...(record.files ? { files: [...record.files] } : {}) };
}

function recordFiles(files: readonly string[] | undefined): { files?: string[] } {
  return files === undefined || files.length === 0 ? {} : { files: files.slice(0, BROWSER_PAGE_DIALOG_FILES_MAX).map(item => clip(item)) };
}

function answeredOutcome(dialog: Omit<BrowserPageDialog, 'answerer'>, answer: BrowserDialogAnswer): BrowserDialogRecordOutcome {
  switch (dialog.kind) {
    case 'alert': return 'accepted';
    case 'beforeunload': return !answer.accept ? 'stayed' : dialog.repeat === undefined ? 'left' : 'accepted';
    case 'file': return !answer.accept ? 'dismissed' : answer.files?.length ? 'uploaded' : 'accepted';
    case 'upload': return answer.accept ? 'accepted' : 'denied';
    case 'download': return 'saved';
    default: return answer.accept ? 'accepted' : 'dismissed';
  }
}

function recordSettled(entry: Entry, reason: SettleReason, answer: BrowserDialogAnswer | undefined): void {
  if (!entry.agentSeen) return;
  const { dialog, download } = entry;
  const shareText = entry.openedControlled || answer?.by === 'agent';
  const text = shareText && dialog.kind === 'prompt' && answer?.accept === true && answer.text !== undefined ? clip(answer.text, BROWSER_DIALOG_RECORD_MESSAGE_MAX) : undefined;
  const record = (outcome: BrowserDialogRecordOutcome, files: readonly string[] | undefined): void => deliverRecord(dialog.browserId, {
    kind: dialog.kind, origin: clip(dialog.origin, 2048),
    ...(dialog.message ? { message: clip(dialog.message, BROWSER_DIALOG_RECORD_MESSAGE_MAX) } : {}),
    ...(text === undefined ? {} : { text }),
    outcome,
    answerer: answer?.by ?? 'auto',
    openedAt: entry.openedAt, settledAt: Date.now(),
    ...recordFiles(files),
    ...(download === undefined ? {} : { downloadId: download.id }),
  });
  if (download !== undefined && (answer !== undefined || reason === 'timeout')) {
    void download.done.then(completed => record(completed ? 'saved' : 'cancelled', completed ? answer?.files ?? dialog.files : undefined), () => record('cancelled', undefined));
    return;
  }
  record(reason === 'timeout' ? 'timed-out' : answer === undefined ? 'cancelled' : answeredOutcome(dialog, answer), dialog.kind === 'file' ? answer?.files : dialog.files);
}

function linger(entry: Entry, accepted: boolean): void {
  const dialogId = entry.dialog.dialogId;
  const timer = setTimeout(() => {
    if (lingering.get(dialogId)?.timer !== timer) return;
    lingering.delete(dialogId);
    publishBrowserDialogs();
  }, AGENT_CHOICE_LINGER_MS);
  timer.unref?.();
  lingering.set(dialogId, { dialog: { ...project(entry), answerer: 'agent', agentChoice: accepted ? 'accepted' : 'dismissed' }, timer });
}

function dropLingering(filter: (dialog: BrowserPageDialog) => boolean): void {
  for (const [dialogId, item] of lingering) {
    if (!filter(item.dialog)) continue;
    clearTimeout(item.timer);
    lingering.delete(dialogId);
  }
}

function cancelChildren(dialogId: string): void {
  for (const child of Array.from(entries.values())) if (child.parent === dialogId && child.answering === undefined) cancelBrowserDialog(child.dialog.dialogId);
}

function settle(dialogId: string, reason: SettleReason): Entry | undefined {
  const entry = entries.get(dialogId);
  if (entry === undefined) return undefined;
  entries.delete(dialogId);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  publishBrowserDialogs();
  recordSettled(entry, reason, undefined);
  cancelChildren(dialogId);
  return entry;
}

function finishAnswer(entry: Entry): boolean {
  const dialogId = entry.dialog.dialogId;
  if (entries.get(dialogId) !== entry) return false;
  entries.delete(dialogId);
  cancelChildren(dialogId);
  return true;
}

function downloadNotices(): Entry[] {
  return [...entries.values()].filter(entry => entry.dialog.kind === 'download');
}

export function openBrowserDialog(input: BrowserDialogInput): string | null {
  const parent = input.parentDialogId === undefined ? undefined : entries.get(input.parentDialogId);
  const downloadsFull = (): boolean => input.kind === 'download' && downloadNotices().length >= MAX_DOWNLOAD_NOTICES;
  const oldest = downloadNotices().find(entry => entry.answering === undefined);
  if (oldest !== undefined && (entries.size >= MAX_DIALOGS || downloadsFull())) expire(oldest.dialog.dialogId);
  if (entries.size >= MAX_DIALOGS || downloadsFull() || (input.parentDialogId !== undefined && (parent === undefined || parent.answering !== undefined))) {
    void Promise.resolve(input.onAnswer(null)).catch(() => {});
    return null;
  }
  const dialogId = `dialog-${randomUUID()}`;
  const controlled = agentControls(input.browserId);
  const dialog: Omit<BrowserPageDialog, 'answerer'> = {
    dialogId, browserId: input.browserId, kind: input.kind, origin: clip(input.origin, 32768), message: clip(input.message ?? ''),
    ...(input.defaultValue === undefined ? {} : { defaultValue: clip(input.defaultValue, BROWSER_PAGE_DIALOG_TEXT_MAX) }),
    ...(input.accept === undefined ? {} : { accept: input.accept.slice(0, 64).map(item => clip(item, 256)) }),
    ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
    ...(input.files === undefined ? {} : { files: input.files.slice(0, BROWSER_PAGE_DIALOG_FILES_MAX).map(item => clip(item)) }),
    ...(input.target === undefined ? {} : { target: clip(input.target, 32768) }),
    ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
  };
  const entry: Entry = {
    dialog, owner: parent?.owner ?? input.owner, parent: input.parentDialogId, userOnly: input.userOnly === true, onAnswer: input.onAnswer, timer: undefined,
    openedAt: Date.now(), agentSeen: controlled, openedControlled: controlled, reminded: false, download: input.download, answering: undefined,
  };
  if (input.timeoutMs !== undefined) {
    entry.timer = setTimeout(() => { expire(dialogId); }, input.timeoutMs);
    entry.timer.unref?.();
  }
  entries.set(dialogId, entry);
  publishBrowserDialogs();
  const projected = project(entry);
  for (const listener of Array.from(openListeners.get(input.browserId) ?? [])) listener(projected);
  return dialogId;
}

export async function respondBrowserDialog(dialogId: string, response: BrowserDialogResponse, by: BrowserDialogAnswerer): Promise<BrowserDialogRespondOutcome> {
  const current = entries.get(dialogId);
  if (current === undefined || current.answering !== undefined) return 'not-found';
  if (current.userOnly && by !== 'user') return 'user-only';
  const answer = { ...response, by };
  if (by === 'user' && current.dialog.kind !== 'download') userAnswered(current.dialog.browserId);
  const entry = current;
  entry.answering = by;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (by === 'agent' && AGENT_CHOICE_KINDS.has(entry.dialog.kind)) linger(entry, answer.accept || entry.dialog.kind === 'alert');
  publishBrowserDialogs();
  cancelChildren(dialogId);
  let final: BrowserDialogAnswer;
  try {
    final = (await entry.onAnswer(answer)) ?? answer;
  } catch (error) {
    if (finishAnswer(entry)) {
      dropLingering(dialog => dialog.dialogId === dialogId);
      publishBrowserDialogs();
      recordSettled(entry, 'cancelled', undefined);
      if (entry.dialog.kind === 'file' || entry.dialog.kind === 'upload') {
        pushAgentBrowserNotice(entry.dialog.browserId, `The files for the file input on ${entry.dialog.origin || 'the page'} could not be attached, so nothing was uploaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw error;
  }
  if (finishAnswer(entry)) {
    publishBrowserDialogs();
    recordSettled(entry, 'answered', final);
  }
  return 'answered';
}

function expire(dialogId: string): void {
  const entry = settle(dialogId, 'timeout');
  if (entry !== undefined) void Promise.resolve(entry.onAnswer(null)).catch(() => {});
}

export function cancelBrowserDialog(dialogId: string): boolean {
  const answering = entries.get(dialogId)?.answering !== undefined;
  const entry = settle(dialogId, 'cancelled');
  if (entry === undefined) return false;
  if (!answering) void Promise.resolve(entry.onAnswer(null)).catch(() => {});
  return true;
}

export function cancelBrowserDialogs(filter: { browserId?: string; owner?: object; kinds?: readonly BrowserPageDialogKind[] }): number {
  const matching = [...entries.values()].filter(entry => matches(entry, filter));
  for (const entry of matching) cancelBrowserDialog(entry.dialog.dialogId);
  return matching.length;
}

function matches(entry: Entry, filter: { browserId?: string; owner?: object; kinds?: readonly BrowserPageDialogKind[] }): boolean {
  return (filter.browserId === undefined || entry.dialog.browserId === filter.browserId)
    && (filter.owner === undefined || entry.owner === filter.owner)
    && (filter.kinds === undefined || filter.kinds.includes(entry.dialog.kind));
}

export function discardBrowserDialogs(filter: { browserId?: string; owner?: object; kinds?: readonly BrowserPageDialogKind[] }): void {
  for (const entry of entries.values()) if (matches(entry, filter)) settle(entry.dialog.dialogId, 'cancelled');
}

export function syncBrowserDialogControl(): void {
  for (const entry of entries.values()) if (!entry.agentSeen && agentControls(entry.dialog.browserId)) entry.agentSeen = true;
  dropLingering(dialog => !agentControls(dialog.browserId));
  for (const browserId of Array.from(histories.keys())) historyFor(browserId, false);
  for (const browserId of Array.from(deferredEvents.keys())) flushDeferredEvents(browserId);
}

function flushDeferredEvents(browserId: string): void {
  const pending = deferredEvents.get(browserId);
  if (pending === undefined || !agentControls(browserId)) return;
  deferredEvents.delete(browserId);
  for (const record of pending) appendRecord(browserId, record, remindedRecords.has(record));
}

export function recordBrowserDialogEvent(browserId: string, event: BrowserDialogEvent, options: { deferred?: boolean } = {}): void {
  const controlled = agentControls(browserId);
  if (!controlled && options.deferred !== true) return;
  const now = Date.now();
  const record: Omit<BrowserDialogRecord, 'id'> = {
    kind: event.kind, origin: clip(event.origin, 2048),
    ...(event.message ? { message: clip(event.message, BROWSER_DIALOG_RECORD_MESSAGE_MAX) } : {}),
    outcome: event.outcome ?? 'blocked', answerer: 'auto', openedAt: now, settledAt: now,
    ...recordFiles(event.files),
    ...(event.downloadId === undefined ? {} : { downloadId: event.downloadId }),
  };
  deliverRecord(browserId, record);
}

function deliverRecord(browserId: string, record: Omit<BrowserDialogRecord, 'id'>): void {
  if (!browserOpen(browserId)) return;
  if (agentControls(browserId)) {
    appendRecord(browserId, record);
    return;
  }
  const pending = deferredEvents.get(browserId) ?? [];
  pending.push(record);
  if (pending.length > BROWSER_DIALOG_HISTORY_MAX) pending.splice(0, pending.length - BROWSER_DIALOG_HISTORY_MAX);
  deferredEvents.set(browserId, pending);
  while (deferredEvents.size > MAX_HISTORY_BROWSERS) deferredEvents.delete(deferredEvents.keys().next().value!);
}

export function listBrowserDialogHistory(browserId: string): BrowserDialogRecord[] {
  return (histories.get(browserId)?.records ?? []).map(item => copyRecord(item.record));
}

export function getBrowserDialogRecord(browserId: string, recordId: string): BrowserDialogRecord | undefined {
  const record = histories.get(browserId)?.records.find(item => item.record.id === recordId)?.record;
  return record === undefined ? undefined : copyRecord(record);
}

export function takeBrowserDialogRecords(browserId: string, fits: (record: BrowserDialogRecord) => boolean = () => true): BrowserDialogRecord[] {
  flushDeferredEvents(browserId);
  const taken: BrowserDialogRecord[] = [];
  const carried = carriedRecords.get(browserId) ?? [];
  while (carried.length > 0) {
    const record = { id: `carried-${randomUUID()}`, ...deliveredRecord(carried[0]!) };
    if (!fits(record)) return taken;
    carried.shift();
    taken.push(record);
  }
  carriedRecords.delete(browserId);
  const history = histories.get(browserId);
  if (history === undefined) return taken;
  const fresh = history.records.filter(item => item.seq > history.delivered).sort((a, b) => a.seq - b.seq);
  for (const item of fresh) {
    if (item.reminded) {
      history.delivered = item.seq;
      continue;
    }
    const record = deliveredRecord(item.record);
    if (!fits(record)) return taken;
    taken.push(record);
    history.delivered = item.seq;
  }
  history.delivered = recordSequence;
  return taken;
}

function deliveredRecord<T extends Omit<BrowserDialogRecord, 'id'>>(source: T): T {
  return source.files === undefined ? { ...source } : { ...source, files: source.files.slice(0, PENDING_LIST_MAX).map(file => clip(file, PENDING_ITEM_MAX * 2)) };
}

function hasFreshRecords(history: History): boolean {
  return history.records.some(item => item.seq > history.delivered && item.reminded === undefined);
}

function hasFreshDeferred(browserId?: string): boolean {
  const lists = browserId === undefined ? [...deferredEvents.values()] : [deferredEvents.get(browserId) ?? []];
  return lists.some(list => list.some(record => !remindedRecords.has(record))) || (browserId === undefined ? carriedRecords.size > 0 : carriedRecords.has(browserId));
}

function remindable(entry: Entry): boolean {
  return entry.agentSeen && !entry.reminded && entry.dialog.kind !== 'download' && entry.answering === undefined;
}

export function hasBrowserDialogReminder(): boolean {
  return [...entries.values()].some(remindable) || hasFreshDeferred() || [...histories.values()].some(hasFreshRecords);
}

export function takeBrowserDialogReminder(tabs: ReadonlyMap<string, string>, fits: { pending: (dialog: BrowserPendingDialog) => BrowserPendingDialog | null; handled: (record: BrowserDialogRecord) => boolean }, now = Date.now()): { pendingDialogs: BrowserPendingDialog[]; handledDialogs: (BrowserDialogRecord & { tabId: string })[]; more: boolean } {
  const pendingDialogs: BrowserPendingDialog[] = [];
  const handledDialogs: (BrowserDialogRecord & { tabId: string })[] = [];
  let more = false;
  for (const dialog of listPendingBrowserDialogs(tabs, now)) {
    const entry = entries.get(dialog.dialogId)!;
    if (!remindable(entry)) continue;
    const shown = more ? null : fits.pending(dialog);
    if (shown === null) { more = true; continue; }
    entry.reminded = true;
    pendingDialogs.push(shown);
  }
  for (const [browserId, tabId] of tabs) {
    if (more) break;
    for (const record of takeBrowserDialogRecords(browserId, fits.handled)) handledDialogs.push({ ...record, tabId });
    const history = histories.get(browserId);
    if (history !== undefined && hasFreshRecords(history)) { more = true; break; }
    for (const [index, source] of (deferredEvents.get(browserId) ?? []).entries()) {
      if (remindedRecords.has(source)) continue;
      const record = { id: `deferred-${index}`, ...deliveredRecord(source) };
      if (!fits.handled(record)) { more = true; break; }
      remindedRecords.add(source);
      handledDialogs.push({ ...record, tabId });
    }
  }
  handledDialogs.sort((a, b) => a.settledAt - b.settledAt);
  return { pendingDialogs, handledDialogs, more };
}

export function forgetBrowserDialogSession(browserIds: readonly string[]): void {
  const forgotten = new Set(browserIds);
  for (const entry of entries.values()) {
    if (!forgotten.has(entry.dialog.browserId)) continue;
    entry.agentSeen = false;
    entry.reminded = false;
  }
  dropLingering(dialog => forgotten.has(dialog.browserId));
  for (const browserId of forgotten) {
    notices.delete(browserId);
    deferredEvents.delete(browserId);
    carriedRecords.delete(browserId);
    if (histories.delete(browserId)) notifyHistory(browserId);
  }
  publishBrowserDialogs();
}

export function updateBrowserDownloadRecord(downloadId: string, patch: { path?: string | null; outcome?: BrowserDialogRecordOutcome }): boolean {
  const patched = <T extends Omit<BrowserDialogRecord, 'id'>>(record: T): T => {
    const { files: _files, ...rest } = record;
    const files = patch.path === undefined ? record.files : patch.path === null ? undefined : [clip(patch.path)];
    return { ...rest, ...(files === undefined ? {} : { files }), ...(patch.outcome === undefined ? {} : { outcome: patch.outcome }), settledAt: Date.now() } as T;
  };
  let found = false;
  for (const queue of [deferredEvents, carriedRecords]) {
    for (const records of queue.values()) {
      for (const [index, record] of records.entries()) {
        if (record.downloadId !== downloadId) continue;
        records[index] = patched(record);
        found = true;
      }
    }
  }
  for (const [browserId, history] of histories) {
    let changed = false;
    for (const item of history.records) {
      if (item.record.downloadId !== downloadId) continue;
      item.record = patched(item.record);
      item.seq = ++recordSequence;
      delete item.reminded;
      changed = true;
    }
    if (changed) notifyHistory(browserId);
    found ||= changed;
  }
  return found;
}

export function onBrowserDialogHistory(listener: (browserId: string) => void): () => void {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

export function onBrowserDialogOpened(browserId: string, listener: (dialog: BrowserPageDialog) => void): () => void {
  let listeners = openListeners.get(browserId);
  if (listeners === undefined) { listeners = new Set(); openListeners.set(browserId, listeners); }
  listeners.add(listener);
  return () => {
    const current = openListeners.get(browserId);
    current?.delete(listener);
    if (current?.size === 0) openListeners.delete(browserId);
  };
}

export function pushBrowserNotice(browserId: string, message: string): void {
  if (!browserOpen(browserId)) return;
  const queue = notices.get(browserId) ?? [];
  const text = clip(message, NOTICE_MAX);
  if (queue.at(-1) === text) return;
  queue.push(text);
  if (queue.length > MAX_NOTICES) queue.splice(0, queue.length - MAX_NOTICES);
  notices.set(browserId, queue);
}

export function pushAgentBrowserNotice(browserId: string | undefined, message: string, event?: BrowserDialogEvent): void {
  if (browserId === undefined || !agentControls(browserId)) return;
  pushBrowserNotice(browserId, message);
  if (event !== undefined) recordBrowserDialogEvent(browserId, event);
}

export function hasPendingBrowserEvents(): boolean {
  if (notices.size > 0 || hasFreshDeferred() || [...entries.values()].some(entry => entry.dialog.kind !== 'download')) return true;
  return [...histories.values()].some(hasFreshRecords);
}

export function takeBrowserNotices(browserId: string, fits: (notice: string) => boolean = () => true): string[] {
  const queue = notices.get(browserId) ?? [];
  let count = 0;
  while (count < queue.length && fits(queue[count]!)) count += 1;
  if (count === queue.length) notices.delete(browserId);
  else notices.set(browserId, queue.slice(count));
  return queue.slice(0, count);
}

export function hasQueuedBrowserEvents(browserId: string): boolean {
  const history = histories.get(browserId);
  return notices.has(browserId) || carriedRecords.has(browserId) || (history !== undefined && hasFreshRecords(history));
}

export function forgetBrowserEvents(browserId: string): void {
  discardBrowserDialogs({ browserId });
  dropLingering(dialog => dialog.browserId === browserId);
  publishBrowserDialogs();
  notices.delete(browserId);
  histories.delete(browserId);
  deferredEvents.delete(browserId);
  carriedRecords.delete(browserId);
}

export function resetBrowserDialogsForTest(): void {
  for (const entry of entries.values()) if (entry.timer !== undefined) clearTimeout(entry.timer);
  entries.clear();
  for (const item of lingering.values()) clearTimeout(item.timer);
  lingering.clear();
  notices.clear();
  histories.clear();
  deferredEvents.clear();
  carriedRecords.clear();
  openListeners.clear();
}
