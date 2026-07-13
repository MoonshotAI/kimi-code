// src/compound-index.ts
//
// Native compound indexes: a group key + an order key, e.g.
//   (workspaceId, updatedAt), (workspaceId, createdAt), (workspaceId, archivedAt)
//
// For each group value we keep a SkipList ordered by the order key, so
// "group = X ORDER BY order" is a range scan — O(log N + limit), no full sort.
// Multiple order columns (multiple dt) are supported by creating one compound
// index per order column.

import { SkipList, cmpNumber, cmpString } from './skiplist.js';
import type { Comparator, RangeOptions } from './skiplist.js';

export type OrderType = 'number' | 'string';

export interface CompoundIndexDef {
  /** value field path used as the group key (e.g. "workspaceId") */
  groupBy: string;
  /** order key: a value field path OR a dt column name (dt takes precedence) */
  orderBy: string;
  orderType?: OrderType;
}

export interface CompoundIndexInfo {
  name: string;
  groupBy: string;
  orderBy: string;
  orderType: OrderType;
}

interface CompoundEntry {
  def: Required<CompoundIndexDef>;
  cmp: Comparator<unknown>;
  groups: Map<unknown, SkipList<unknown, string>>; // groupValue -> ordered pks
  byPk: Map<string, { group: unknown; order: unknown }>; // pk -> current placement
}

function getPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]), doc);
}

export class CompoundIndexManager {
  readonly indexes = new Map<string, CompoundEntry>();

  create(name: string, def: CompoundIndexDef): void {
    if (this.indexes.has(name)) throw new Error(`compound index "${name}" already exists`);
    const orderType = def.orderType ?? 'number';
    const full: Required<CompoundIndexDef> = { groupBy: def.groupBy, orderBy: def.orderBy, orderType };
    const cmp = orderType === 'string' ? (cmpString as Comparator<unknown>) : (cmpNumber as Comparator<unknown>);
    this.indexes.set(name, { def: full, cmp, groups: new Map(), byPk: new Map() });
  }

  drop(name: string): boolean {
    return this.indexes.delete(name);
  }

  list(): CompoundIndexInfo[] {
    return [...this.indexes.entries()].map(([name, e]) => ({
      name,
      groupBy: e.def.groupBy,
      orderBy: e.def.orderBy,
      orderType: e.def.orderType,
    }));
  }

  private groupOf(entry: CompoundEntry, group: unknown): SkipList<unknown, string> {
    let list = entry.groups.get(group);
    if (!list) {
      list = new SkipList<unknown, string>({ compareKey: entry.cmp, compareVal: cmpString });
      entry.groups.set(group, list);
    }
    return list;
  }

  private extract(entry: CompoundEntry, doc: unknown, dt: Record<string, number> | null): { group: unknown; order: unknown } {
    const group = getPath(doc, entry.def.groupBy);
    const order =
      dt && entry.def.orderBy in dt ? (dt as Record<string, unknown>)[entry.def.orderBy] : getPath(doc, entry.def.orderBy);
    return { group, order };
  }

  private validOrder(entry: CompoundEntry, order: unknown): boolean {
    if (entry.def.orderType === 'number') return typeof order === 'number' && Number.isFinite(order);
    return typeof order === 'string';
  }

  /** Add/update a document across all compound indexes. */
  add(pk: string, doc: unknown, dt: Record<string, number> | null): void {
    for (const entry of this.indexes.values()) {
      const { group, order } = this.extract(entry, doc, dt);
      const prev = entry.byPk.get(pk);
      const valid = group !== undefined && group !== null && this.validOrder(entry, order);

      // No-op when placement is unchanged. Without this guard, re-setting a key
      // with the same group+order inserted a duplicate skiplist node (and a
      // later delete left a phantom entry behind).
      if (prev && valid && prev.group === group && prev.order === order) continue;

      if (prev) {
        const oldList = entry.groups.get(prev.group);
        if (oldList) {
          oldList.delete(prev.order, pk);
          if (oldList.length === 0) entry.groups.delete(prev.group);
        }
      }

      if (valid) {
        this.groupOf(entry, group).insert(order, pk);
        entry.byPk.set(pk, { group, order });
      } else {
        entry.byPk.delete(pk);
      }
    }
  }

  remove(pk: string, _doc?: unknown, _dt?: Record<string, number> | null): void {
    for (const entry of this.indexes.values()) {
      const prev = entry.byPk.get(pk);
      if (prev) {
        const oldList = entry.groups.get(prev.group);
        if (oldList) oldList.delete(prev.order, pk);
        entry.byPk.delete(pk);
      }
    }
  }

  /** Range over a group, ordered by the order key. */
  range(
    name: string,
    groupValue: unknown,
    opts: RangeOptions<unknown> & { limit?: number } = {},
  ): { key: string; orderValue: unknown }[] {
    const entry = this.indexes.get(name);
    if (!entry) throw new Error(`no such compound index: ${name}`);
    const list = entry.groups.get(groupValue);
    if (!list) return [];
    return list
      .range({ ...opts, count: opts.limit ?? opts.count })
      .map((n) => ({ key: n.val, orderValue: n.key }));
  }

  /** Rebuild from entries of { key, value, dt }. */
  rebuild(entries: Iterable<{ key: string | Buffer; value: unknown; dt?: Record<string, number> | null }>): void {
    for (const entry of this.indexes.values()) {
      entry.groups.clear();
      entry.byPk.clear();
    }
    for (const { key, value, dt } of entries) {
      this.add(typeof key === 'string' ? key : Buffer.from(key).toString('binary'), value, dt ?? null);
    }
  }
}
