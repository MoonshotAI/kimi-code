import {
  applyUiPreferenceOp,
  isPlainPreferenceObject,
  sameUiPreferenceValue,
  UI_PREFERENCE_DEFINITIONS,
  uiPreferenceDefinition,
  type UiPreferenceKey,
  type UiPreferenceOperation,
} from '@moonshot-ai/kimi-code-product/ui-preferences';

import { safeGetString, safeRemove, safeSetJson, safeSetString } from './safeStorage';

export type UiPreferencesMode = 'local' | 'server';

export type UiPreferencesEventOutcome = 'applied' | 'ignored' | 'behind';

export interface UiPreferencesSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, unknown>>;
}

type ChangeListener = (keys: readonly string[]) => void;

const CACHE_PREFIX = 'kimi-web.ui-preferences:';
const IMPORTED_PREFIX = 'kimi-web.ui-preferences-imported:';
const OUTBOX_PREFIX = 'kimi-web.ui-preferences-outbox:';
const MAX_DIFF_OPS = 50;

function readJson(key: string): unknown {
  const raw = safeGetString(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readCache(key: string): Record<string, unknown> | undefined {
  const parsed = readJson(key);
  return isPlainPreferenceObject(parsed) && isPlainPreferenceObject(parsed['values']) ? parsed['values'] : undefined;
}

function isOperation(value: unknown): value is UiPreferenceOperation {
  return isPlainPreferenceObject(value) && typeof value['op'] === 'string' && typeof value['key'] === 'string';
}

function readOutbox(key: string): UiPreferenceOperation[] {
  const parsed = readJson(key);
  return Array.isArray(parsed) ? parsed.filter(isOperation) : [];
}

function applyLocally(values: Record<string, unknown>, ops: readonly UiPreferenceOperation[]): void {
  for (const op of ops) {
    const result = applyUiPreferenceOp(values[op.key], op);
    if (!result.ok) continue;
    if (result.value === undefined) delete values[op.key];
    else values[op.key] = result.value;
  }
}

function setDiffOps(key: string, previous: readonly unknown[], next: readonly unknown[]): UiPreferenceOperation[] {
  const ops: UiPreferenceOperation[] = [];
  for (const item of previous) {
    if (!next.some((candidate) => sameUiPreferenceValue(candidate, item))) ops.push({ op: 'remove', key, value: item });
  }
  for (const item of next) {
    if (!previous.some((candidate) => sameUiPreferenceValue(candidate, item))) ops.push({ op: 'add', key, value: item });
  }
  return ops;
}

function mapDiffOps(
  key: string,
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): UiPreferenceOperation[] {
  const ops: UiPreferenceOperation[] = [];
  for (const field of Object.keys(previous)) {
    if (!Object.hasOwn(next, field)) ops.push({ op: 'unset_field', key, field });
  }
  for (const [field, value] of Object.entries(next)) {
    if (!sameUiPreferenceValue(previous[field], value)) ops.push({ op: 'set_field', key, field, value });
  }
  return ops;
}

export function uiPreferenceWriteOps(key: string, previous: unknown, next: unknown): UiPreferenceOperation[] {
  if (sameUiPreferenceValue(previous, next)) return [];
  if (next === undefined) return [{ op: 'unset', key }];
  const merge = uiPreferenceDefinition(key).merge;
  const diff =
    merge === 'set' && Array.isArray(previous) && Array.isArray(next)
      ? setDiffOps(key, previous, next)
      : merge === 'map' && isPlainPreferenceObject(previous) && isPlainPreferenceObject(next)
        ? mapDiffOps(key, previous, next)
        : undefined;
  if (diff === undefined || diff.length > MAX_DIFF_OPS) return [{ op: 'set', key, value: next }];
  if (merge !== 'set') return diff;
  const applied: Record<string, unknown> = { [key]: previous };
  applyLocally(applied, diff);
  return sameUiPreferenceValue(applied[key], next) ? diff : [{ op: 'set', key, value: next }];
}

export class UiPreferencesState {
  private currentMode: UiPreferencesMode = 'local';
  private serverKey: string | undefined;
  private values: Record<string, unknown> = {};
  private revision: number | undefined;
  private queued: UiPreferenceOperation[] = [];
  private unconfirmed: UiPreferenceOperation[] = [];
  private readonly inflight = new Map<string, number>();
  private readonly skippedWhilePending = new Set<string>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly queueListeners = new Set<() => void>();

  get mode(): UiPreferencesMode {
    return this.currentMode;
  }

  get knownRevision(): number | undefined {
    return this.revision;
  }

  get bound(): boolean {
    return this.serverKey !== undefined;
  }

  bind(serverKey: string): void {
    this.serverKey = serverKey;
    this.revision = undefined;
    this.inflight.clear();
    this.skippedWhilePending.clear();
    const cached = readCache(CACHE_PREFIX + serverKey);
    this.currentMode = cached === undefined ? 'local' : 'server';
    this.unconfirmed = cached === undefined ? [] : readOutbox(OUTBOX_PREFIX + serverKey);
    this.queued = [...this.unconfirmed];
    this.replace(cached ?? {}, true);
  }

  get imported(): boolean {
    return this.serverKey !== undefined && safeGetString(IMPORTED_PREFIX + this.serverKey) === '1';
  }

  markImported(): void {
    if (this.serverKey !== undefined) safeSetString(IMPORTED_PREFIX + this.serverKey, '1');
  }

  value(key: string): unknown {
    return this.values[key];
  }

  write(key: string, next: unknown): boolean {
    if (this.currentMode !== 'server') return false;
    const ops = uiPreferenceWriteOps(key, this.values[key], next);
    if (ops.length === 0) return true;
    if (ops.some((op) => op.op === 'set' || op.op === 'unset')) {
      const superseded = new Set(this.queued.filter((op) => op.key === key));
      this.queued = this.queued.filter((op) => !superseded.has(op));
      this.unconfirmed = this.unconfirmed.filter((op) => !superseded.has(op));
    }
    this.queued.push(...ops);
    this.unconfirmed.push(...ops);
    this.saveOutbox();
    const values = { ...this.values };
    applyLocally(values, ops);
    this.replace(values);
    for (const listener of this.queueListeners) listener();
    return true;
  }

  hasQueued(): boolean {
    return this.queued.length > 0;
  }

  takeQueued(): UiPreferenceOperation[] {
    const ops = this.queued;
    this.queued = [];
    for (const op of ops) this.inflight.set(op.key, (this.inflight.get(op.key) ?? 0) + 1);
    return ops;
  }

  settle(ops: readonly UiPreferenceOperation[], changed: Readonly<Record<string, unknown>> | undefined): boolean {
    this.release(ops);
    const settled = new Set(ops);
    this.unconfirmed = this.unconfirmed.filter((op) => !settled.has(op));
    this.saveOutbox();
    if (changed === undefined) return false;
    const values = { ...this.values };
    for (const [key, value] of Object.entries(changed)) {
      if (this.isPending(key)) continue;
      this.skippedWhilePending.delete(key);
      if (value === null) delete values[key];
      else values[key] = value;
    }
    this.replace(values);
    const stale = [...this.skippedWhilePending].filter((key) => !this.isPending(key));
    for (const key of stale) this.skippedWhilePending.delete(key);
    return stale.length > 0;
  }

  requeue(ops: readonly UiPreferenceOperation[]): void {
    this.release(ops);
    this.queued = [...ops, ...this.queued];
  }

  applySnapshot(snapshot: UiPreferencesSnapshot): void {
    this.currentMode = 'server';
    this.revision = snapshot.revision;
    this.skippedWhilePending.clear();
    const values = { ...snapshot.values };
    applyLocally(values, this.queued);
    this.replace(values, true);
  }

  applyEvent(revision: number, changed: Readonly<Record<string, unknown>>): UiPreferencesEventOutcome {
    if (this.currentMode !== 'server' || this.revision === undefined || revision === this.revision) return 'ignored';
    if (revision < this.revision) return 'behind';
    this.revision = revision;
    const values = { ...this.values };
    for (const [key, value] of Object.entries(changed)) {
      if (this.isPending(key)) {
        this.skippedWhilePending.add(key);
        continue;
      }
      if (value === null) delete values[key];
      else values[key] = value;
    }
    this.replace(values);
    return 'applied';
  }

  fallBackToLocal(): void {
    if (this.serverKey !== undefined) safeRemove(CACHE_PREFIX + this.serverKey);
    const keys = [...new Set([...Object.keys(this.values), ...Object.keys(UI_PREFERENCE_DEFINITIONS)])];
    this.currentMode = 'local';
    this.revision = undefined;
    this.queued = [];
    this.unconfirmed = [];
    this.saveOutbox();
    this.inflight.clear();
    this.values = {};
    this.notify(keys);
  }

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onQueued(listener: () => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  private saveOutbox(): void {
    if (this.serverKey === undefined) return;
    if (this.unconfirmed.length === 0) safeRemove(OUTBOX_PREFIX + this.serverKey);
    else safeSetJson(OUTBOX_PREFIX + this.serverKey, this.unconfirmed);
  }

  private isPending(key: string): boolean {
    return (this.inflight.get(key) ?? 0) > 0 || this.queued.some((op) => op.key === key);
  }

  private release(ops: readonly UiPreferenceOperation[]): void {
    for (const op of ops) {
      const count = (this.inflight.get(op.key) ?? 0) - 1;
      if (count > 0) this.inflight.set(op.key, count);
      else this.inflight.delete(op.key);
    }
  }

  private replace(values: Record<string, unknown>, notifyAll = false): void {
    const keys = new Set([...Object.keys(this.values), ...Object.keys(values)]);
    const changed = notifyAll
      ? [...new Set([...keys, ...Object.keys(UI_PREFERENCE_DEFINITIONS)])]
      : [...keys].filter((key) => !sameUiPreferenceValue(this.values[key], values[key]));
    this.values = values;
    if (this.currentMode === 'server' && this.serverKey !== undefined) {
      safeSetJson(CACHE_PREFIX + this.serverKey, { values });
    }
    this.notify(changed);
  }

  private notify(keys: readonly string[]): void {
    if (keys.length === 0) return;
    for (const listener of this.changeListeners) listener(keys);
  }
}

export const uiPreferences = new UiPreferencesState();

export { UI_PREFERENCE_KEYS, type UiPreferenceKey } from '@moonshot-ai/kimi-code-product/ui-preferences';

export function followUiPreferences(keys: readonly UiPreferenceKey[], reload: () => void): () => void {
  const watched = new Set<string>(keys);
  return uiPreferences.onChange((changed) => {
    if (changed.some((key) => watched.has(key))) reload();
  });
}
