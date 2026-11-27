import {
  applyUiPreferenceOp,
  isPlainPreferenceObject as isPlainObject,
  sameUiPreferenceValue as sameJson,
  UI_PREFERENCE_VALUE_MAX_BYTES,
  UI_PREFERENCES_DOCUMENT_MAX_BYTES,
  uiPreferenceDefinition,
} from '@moonshot-ai/kimi-code-product/ui-preferences';

import { ErrorCode } from '../../protocol/error-codes';
import type { UiPreferenceOp } from '../../protocol/rest-ui-preferences';

export type UiPreferenceOrigin = 'import' | 'user';

export interface UiPreferencesDocument {
  readonly version: 1;
  readonly revision: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly origins: Readonly<Record<string, UiPreferenceOrigin>>;
}

export type UiPreferencesChanges = Record<string, unknown>;

export interface UiPreferencesWrite {
  readonly document: UiPreferencesDocument;
  readonly changed: UiPreferencesChanges;
}

export interface UiPreferencesImport extends UiPreferencesWrite {
  readonly imported: readonly string[];
  readonly skipped: readonly string[];
}

export class UiPreferencesError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly key?: string,
  ) {
    super(message);
  }
}

export const EMPTY_UI_PREFERENCES: UiPreferencesDocument = {
  version: 1,
  revision: 0,
  values: {},
  origins: {},
};

const textEncoder = new TextEncoder();

function byteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function isOrigin(value: unknown): value is UiPreferenceOrigin {
  return value === 'import' || value === 'user';
}

export function parseUiPreferencesDocument(raw: unknown): UiPreferencesDocument {
  if (raw === undefined) return EMPTY_UI_PREFERENCES;
  if (
    !isPlainObject(raw) ||
    typeof raw['revision'] !== 'number' ||
    !Number.isSafeInteger(raw['revision']) ||
    raw['revision'] < 0 ||
    !isPlainObject(raw['values'])
  ) {
    throw new UiPreferencesError(ErrorCode.PERSISTENCE_FAILURE, 'ui preferences file is corrupted');
  }
  const origins: Record<string, UiPreferenceOrigin> = {};
  if (isPlainObject(raw['origins'])) {
    for (const [key, origin] of Object.entries(raw['origins'])) {
      if (isOrigin(origin)) origins[key] = origin;
    }
  }
  return { version: 1, revision: raw['revision'], values: { ...raw['values'] }, origins };
}

export function diffUiPreferences(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): UiPreferencesChanges {
  const changed: UiPreferencesChanges = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameJson(before[key], after[key])) changed[key] = after[key] ?? null;
  }
  return changed;
}

function assertValueSize(key: string, value: unknown): void {
  if (value !== undefined && byteLength(value) > UI_PREFERENCE_VALUE_MAX_BYTES) {
    throw new UiPreferencesError(
      ErrorCode.UI_PREFERENCES_TOO_LARGE,
      `value of ${key} exceeds ${UI_PREFERENCE_VALUE_MAX_BYTES} bytes`,
      key,
    );
  }
}

function assertDocumentSize(values: Readonly<Record<string, unknown>>): void {
  if (byteLength(values) > UI_PREFERENCES_DOCUMENT_MAX_BYTES) {
    throw new UiPreferencesError(
      ErrorCode.UI_PREFERENCES_TOO_LARGE,
      `ui preferences exceed ${UI_PREFERENCES_DOCUMENT_MAX_BYTES} bytes`,
    );
  }
}

export function applyUiPreferenceOps(
  document: UiPreferencesDocument,
  ops: readonly UiPreferenceOp[],
): UiPreferencesWrite {
  const values: Record<string, unknown> = { ...document.values };
  const origins: Record<string, UiPreferenceOrigin> = { ...document.origins };
  for (const op of ops) {
    const result = applyUiPreferenceOp(values[op.key], op);
    if (!result.ok) {
      throw new UiPreferencesError(
        ErrorCode.UI_PREFERENCE_TYPE_MISMATCH,
        `${op.op} needs ${op.key} to be an ${result.expected}`,
        op.key,
      );
    }
    const next = result.value;
    assertValueSize(op.key, next);
    if (next === undefined) delete values[op.key];
    else values[op.key] = next;
    origins[op.key] = 'user';
  }
  assertDocumentSize(values);
  return writeResult(document, values, origins);
}

function writeResult(
  document: UiPreferencesDocument,
  values: Record<string, unknown>,
  origins: Record<string, UiPreferenceOrigin>,
): UiPreferencesWrite {
  const changed = diffUiPreferences(document.values, values);
  const touched = Object.keys(changed).length > 0 || !sameJson(document.origins, origins);
  return {
    document: touched
      ? { version: 1, revision: document.revision + 1, values, origins }
      : document,
    changed,
  };
}

function uniqueAppend(base: readonly unknown[], extra: readonly unknown[]): unknown[] {
  const out = [...base];
  for (const item of extra) {
    if (!out.some((existing) => sameJson(existing, item))) out.push(item);
  }
  return out;
}

function mergeImported(key: string, current: unknown, incoming: unknown, hasCurrent: boolean): unknown {
  switch (uiPreferenceDefinition(key).merge) {
    case 'scalar':
      return hasCurrent ? current : incoming;
    case 'flag':
      if (typeof incoming !== 'boolean') return undefined;
      return current === true || incoming;
    case 'set':
    case 'ordered':
      return Array.isArray(incoming) ? uniqueAppend(Array.isArray(current) ? current : [], incoming) : undefined;
    case 'map': {
      if (!isPlainObject(incoming)) return undefined;
      return { ...incoming, ...(isPlainObject(current) ? current : {}) };
    }
  }
}

export function importUiPreferences(
  document: UiPreferencesDocument,
  incoming: Readonly<Record<string, unknown>>,
): UiPreferencesImport {
  const values: Record<string, unknown> = { ...document.values };
  const origins: Record<string, UiPreferenceOrigin> = { ...document.origins };
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const hasCurrent = Object.hasOwn(values, key);
    const merged = origins[key] !== 'user' && value !== undefined ? mergeImported(key, values[key], value, hasCurrent) : undefined;
    if (merged === undefined || byteLength(merged) > UI_PREFERENCE_VALUE_MAX_BYTES) {
      skipped.push(key);
      continue;
    }
    if (hasCurrent && sameJson(values[key], merged)) {
      skipped.push(key);
      continue;
    }
    values[key] = merged;
    origins[key] = 'import';
    imported.push(key);
  }
  assertDocumentSize(values);
  return { ...writeResult(document, values, origins), imported, skipped };
}
