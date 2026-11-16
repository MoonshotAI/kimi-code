import {
  EVENT_FINDING_STATUS_CHANGED,
  atLeastSeverity,
  severityRank,
  type NotifyFilter,
  type NotifySnapshot,
} from './types';

function readString(obj: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string') return val;
  }
  return undefined;
}

function readNumberArray(
  obj: Record<string, unknown>,
  ...keys: readonly string[]
): number[] | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (Array.isArray(val) && val.every((item) => typeof item === 'number')) {
      return [...val];
    }
  }
  return undefined;
}

function readStringArray(
  obj: Record<string, unknown>,
  ...keys: readonly string[]
): string[] | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
      return [...val];
    }
  }
  return undefined;
}

function readBoolean(obj: Record<string, unknown>, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'boolean') return val;
  }
  return undefined;
}

export function parseFilter(raw: string | Buffer | Uint8Array | undefined): NotifyFilter {
  if (raw === undefined) return {};
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  return {
    minSeverity: readString(obj, 'minSeverity', 'min_severity'),
    taskIds: readNumberArray(obj, 'taskIds', 'task_ids'),
    assetIds: readNumberArray(obj, 'assetIds', 'asset_ids'),
    includeCategories: readStringArray(obj, 'includeCategories', 'vulnclass_include'),
    excludeCategories: readStringArray(obj, 'excludeCategories', 'vulnclass_exclude'),
    onStatusChange: readBoolean(obj, 'onStatusChange', 'on_status_change'),
  };
}

export function validMinSeverity(min: string | undefined): boolean {
  if (min === undefined || min === '') return true;
  return severityRank(min) > 0;
}

export function validateFilter(filter: NotifyFilter): void {
  if (!validMinSeverity(filter.minSeverity)) {
    throw new Error(
      `invalid min_severity "${filter.minSeverity ?? ''}"; valid values: low / medium / high / critical, or empty for no threshold`,
    );
  }
}

function intersectsNumbers(a: readonly number[], b: readonly number[]): boolean {
  for (const v of b) {
    if (a.includes(v)) return true;
  }
  return false;
}

function containsAnyFold(target: string, keywords: readonly string[]): boolean {
  const lower = target.toLowerCase();
  for (const kw of keywords) {
    const trimmed = kw.trim().toLowerCase();
    if (trimmed !== '' && lower.includes(trimmed)) return true;
  }
  return false;
}

export function matchesFilter(filter: NotifyFilter, snapshot: NotifySnapshot): boolean {
  if (snapshot.kind === EVENT_FINDING_STATUS_CHANGED && filter.onStatusChange !== true) {
    return false;
  }
  if (!atLeastSeverity(snapshot.severity, filter.minSeverity ?? '')) {
    return false;
  }
  if (filter.taskIds !== undefined && filter.taskIds.length > 0 && !filter.taskIds.includes(snapshot.taskId)) {
    return false;
  }
  if (
    filter.assetIds !== undefined &&
    filter.assetIds.length > 0 &&
    !intersectsNumbers(filter.assetIds, snapshot.assetIds)
  ) {
    return false;
  }
  if (
    filter.excludeCategories !== undefined &&
    filter.excludeCategories.length > 0 &&
    containsAnyFold(snapshot.vulnclass, filter.excludeCategories)
  ) {
    return false;
  }
  if (
    filter.includeCategories !== undefined &&
    filter.includeCategories.length > 0 &&
    !containsAnyFold(snapshot.vulnclass, filter.includeCategories)
  ) {
    return false;
  }
  return true;
}
