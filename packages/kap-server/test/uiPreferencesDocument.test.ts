import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import {
  applyUiPreferenceOps,
  EMPTY_UI_PREFERENCES,
  importUiPreferences,
  parseUiPreferencesDocument,
  UiPreferencesError,
} from '../src/services/uiPreferences/document';

function errorCodeOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof UiPreferencesError) return error.code;
    throw error;
  }
  return undefined;
}

describe('UI preference operations', () => {
  it('merges map fields so two workspaces keep their own value', () => {
    const first = applyUiPreferenceOps(EMPTY_UI_PREFERENCES, [
      { op: 'set_field', key: 'sidebar.workspace_recency_floor', field: 'wd_a', value: 100 },
    ]).document;
    const second = applyUiPreferenceOps(first, [
      { op: 'set_field', key: 'sidebar.workspace_recency_floor', field: 'wd_b', value: 200 },
      { op: 'unset_field', key: 'sidebar.workspace_recency_floor', field: 'missing' },
    ]);

    expect(second.document.revision).toBe(2);
    expect(second.changed).toEqual({ 'sidebar.workspace_recency_floor': { wd_a: 100, wd_b: 200 } });
  });

  it('rejects set operations on a key that holds another type', () => {
    const scalar = applyUiPreferenceOps(EMPTY_UI_PREFERENCES, [
      { op: 'set', key: 'sidebar.view_mode', value: 'flat' },
    ]).document;

    expect(errorCodeOf(() => applyUiPreferenceOps(scalar, [{ op: 'add', key: 'sidebar.view_mode', value: 'x' }]))).toBe(
      ErrorCode.UI_PREFERENCE_TYPE_MISMATCH,
    );
    expect(
      errorCodeOf(() =>
        applyUiPreferenceOps(scalar, [{ op: 'set_field', key: 'sidebar.view_mode', field: 'a', value: 1 }]),
      ),
    ).toBe(ErrorCode.UI_PREFERENCE_TYPE_MISMATCH);
  });

  it('rejects a value over the per-key limit and keeps the document unchanged', () => {
    const huge = 'x'.repeat(70 * 1024);
    expect(
      errorCodeOf(() => applyUiPreferenceOps(EMPTY_UI_PREFERENCES, [{ op: 'set', key: 'sidebar.view_mode', value: huge }])),
    ).toBe(ErrorCode.UI_PREFERENCES_TOO_LARGE);
  });

  it('does not bump the revision when nothing changes', () => {
    const pinned = applyUiPreferenceOps(EMPTY_UI_PREFERENCES, [
      { op: 'add', key: 'sidebar.pinned_sessions', value: 's1' },
    ]).document;
    const again = applyUiPreferenceOps(pinned, [{ op: 'add', key: 'sidebar.pinned_sessions', value: 's1' }]);

    expect(again.document).toBe(pinned);
    expect(again.changed).toEqual({});
  });
});

describe('UI preference import', () => {
  it('does not bring back a key the user deleted', () => {
    const imported = importUiPreferences(EMPTY_UI_PREFERENCES, { 'sidebar.view_mode': 'flat' }).document;
    const deleted = applyUiPreferenceOps(imported, [{ op: 'unset', key: 'sidebar.view_mode' }]).document;

    const late = importUiPreferences(deleted, { 'sidebar.view_mode': 'grouped' });

    expect(late.skipped).toEqual(['sidebar.view_mode']);
    expect(late.document.values).toEqual({});
  });

  it('appends the workspaces another client ordered after the first order', () => {
    const imported = importUiPreferences(EMPTY_UI_PREFERENCES, { 'sidebar.workspace_order': ['wd_a', 'wd_b'] }).document;

    const merged = importUiPreferences(imported, { 'sidebar.workspace_order': ['wd_c', 'wd_b', 'wd_a'] });

    expect(merged.document.values['sidebar.workspace_order']).toEqual(['wd_a', 'wd_b', 'wd_c']);
  });

  it('keeps the first value for each map field', () => {
    const imported = importUiPreferences(EMPTY_UI_PREFERENCES, {
      'sidebar.workspace_recency_floor': { wd_a: 1 },
    }).document;

    const merged = importUiPreferences(imported, { 'sidebar.workspace_recency_floor': { wd_a: 5, wd_b: 2 } });

    expect(merged.document.values['sidebar.workspace_recency_floor']).toEqual({ wd_a: 1, wd_b: 2 });
  });

  it('skips values whose shape does not fit the key type', () => {
    const result = importUiPreferences(EMPTY_UI_PREFERENCES, {
      'sidebar.pinned_sessions': 'not-a-list',
      'onboarding.completed': 'yes',
    });

    expect(result.skipped.toSorted()).toEqual(['onboarding.completed', 'sidebar.pinned_sessions']);
    expect(result.document).toBe(EMPTY_UI_PREFERENCES);
  });
});

describe('UI preferences file', () => {
  it('treats a missing file as empty and a malformed one as a persistence failure', () => {
    expect(parseUiPreferencesDocument(undefined)).toBe(EMPTY_UI_PREFERENCES);
    expect(errorCodeOf(() => parseUiPreferencesDocument({ revision: 'one', values: {} }))).toBe(
      ErrorCode.PERSISTENCE_FAILURE,
    );
  });
});
