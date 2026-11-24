import { displayType, type ContractField, type ContractSummary } from '#/contract/summary';

export type ContractChangeKind = 'breaking' | 'non-breaking' | 'unclassified';

export interface ContractChange {
  readonly kind: ContractChangeKind;
  readonly key: string;
  readonly detail: string;
}

const KIND_ORDER: Record<ContractChangeKind, number> = { breaking: 0, unclassified: 1, 'non-breaking': 2 };
const LISTED_CHANGES = 60;

export function classifyContractChanges(before: ContractSummary, after: ContractSummary): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const [key, old] of before.fields) {
    const next = after.fields.get(key);
    if (next !== undefined) changes.push(...changed(old, next));
    else if (!ownerChanged(key, before, after)) changes.push(removed(old));
  }
  for (const [key, next] of after.fields) {
    if (!before.fields.has(key) && !ownerChanged(key, after, before)) changes.push(added(next));
  }
  return changes.toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key));
}

export function describeContractChanges(changes: readonly ContractChange[]): string[] {
  const counts = (['breaking', 'unclassified', 'non-breaking'] as const).map((kind) => `${changes.filter((change) => change.kind === kind).length} ${kind}`);
  const listed = changes.slice(0, LISTED_CHANGES).map((change) => `- ${change.kind}: ${change.key} — ${change.detail}`);
  const hidden = changes.length - listed.length;
  return [`${changes.length} contract change(s): ${counts.join(', ')}`, ...listed, ...(hidden > 0 ? [`- … and ${hidden} more`] : [])];
}

function ownerChanged(key: string, present: ContractSummary, other: ContractSummary): boolean {
  const owner = ownerOf(key);
  return owner !== key && present.fields.has(owner) && !other.fields.has(owner);
}

function ownerOf(key: string): string {
  const message = /^ws (?:client|server) message [^.<[{]+/.exec(key);
  if (message !== null) return message[0];
  const [method, path] = key.split(' ');
  return `${method} ${path}`;
}

function removed(field: ContractField): ContractChange {
  if (field.base === 'operation') return { kind: 'breaking', key: field.key, detail: 'operation removed' };
  if (field.direction === 'output') return { kind: 'breaking', key: field.key, detail: `no longer sent (${displayType(field)})` };
  return { kind: field.parentClosed ? 'breaking' : 'unclassified', key: field.key, detail: `input no longer accepted (${displayType(field)})` };
}

function added(field: ContractField): ContractChange {
  if (field.base === 'operation') return { kind: 'non-breaking', key: field.key, detail: 'operation added' };
  if (/^ws server message [^.<[{]+$/.test(field.key)) {
    return { kind: 'unclassified', key: field.key, detail: 'new server message; clients must ignore message types they do not know' };
  }
  if (field.direction === 'input') {
    return field.required
      ? { kind: 'breaking', key: field.key, detail: `new required input (${displayType(field)})` }
      : { kind: 'non-breaking', key: field.key, detail: `new optional input (${displayType(field)})` };
  }
  return { kind: 'non-breaking', key: field.key, detail: `new output (${displayType(field)})` };
}

function changed(old: ContractField, next: ContractField): ContractChange[] {
  const changes: ContractChange[] = [];
  const input = old.direction === 'input';
  const change = (kind: ContractChangeKind, detail: string): void => {
    changes.push({ kind, key: old.key, detail });
  };
  if (old.base !== next.base) change('breaking', `type ${old.base} → ${next.base}`);
  else if (old.values !== undefined && next.values !== undefined) {
    const dropped = old.values.filter((value) => !next.values?.includes(value));
    const extra = next.values.filter((value) => !old.values?.includes(value));
    if (dropped.length > 0) change(input ? 'breaking' : 'non-breaking', `${input ? 'no longer accepts' : 'no longer sends'} ${dropped.join(', ')}`);
    if (extra.length > 0) change(input ? 'non-breaking' : 'unclassified', `${input ? 'now accepts' : 'may now send'} ${extra.join(', ')}`);
  }
  if (old.nullable !== next.nullable) {
    const risky = input ? !next.nullable : next.nullable;
    change(risky ? 'breaking' : 'non-breaking', next.nullable ? 'may now be null' : 'can no longer be null');
  }
  if (old.closed !== next.closed) {
    change(input && next.closed ? 'breaking' : 'non-breaking', next.closed ? 'now rejects unknown properties' : 'now allows unknown properties');
  }
  if (old.defaultValue !== next.defaultValue) {
    const detail = old.defaultValue === undefined
      ? `now defaults to ${next.defaultValue}`
      : next.defaultValue === undefined ? `no longer defaults to ${old.defaultValue}` : `default ${old.defaultValue} → ${next.defaultValue}`;
    change('unclassified', `${detail}; clients that omit it get the new behavior`);
  }
  if (old.required !== next.required) {
    const risky = input ? next.required : !next.required;
    change(risky ? 'breaking' : 'non-breaking', next.required ? 'now required' : 'now optional');
  }
  for (const keyword of new Set([...Object.keys(old.constraints), ...Object.keys(next.constraints)])) {
    const before = old.constraints[keyword];
    const after = next.constraints[keyword];
    if (before === after) continue;
    const tighter = tightens(keyword, before, after);
    const detail = before === undefined ? `now limits ${keyword}=${after}` : after === undefined ? `no longer limits ${keyword}` : `${keyword} ${before} → ${after}`;
    if (input) change(tighter ? 'breaking' : 'non-breaking', detail);
    else change(tighter ? 'non-breaking' : 'unclassified', detail);
  }
  return changes;
}

const LOWER_BOUNDS = new Set(['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties']);
const UPPER_BOUNDS = new Set(['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties']);

function tightens(keyword: string, before: string | undefined, after: string | undefined): boolean {
  if (after === undefined) return false;
  if (before === undefined) return true;
  const from = Number(before);
  const to = Number(after);
  if (LOWER_BOUNDS.has(keyword) && Number.isFinite(from) && Number.isFinite(to)) return to > from;
  if (UPPER_BOUNDS.has(keyword) && Number.isFinite(from) && Number.isFinite(to)) return to < from;
  return true;
}
