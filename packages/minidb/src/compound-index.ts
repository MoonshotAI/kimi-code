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
  /** In-flight createCompoundIndex transactions (plan 10's staged → persist →
   *  publish), same discipline as IndexManager.staged: invisible to every
   *  query path until the sidecar persist succeeds and publish() moves the
   *  entry into the live map. */
  private readonly staged = new Map<string, CompoundEntry>();

  private static entry(def: CompoundIndexDef): CompoundEntry {
    const orderType = def.orderType ?? 'number';
    const full: Required<CompoundIndexDef> = { groupBy: def.groupBy, orderBy: def.orderBy, orderType };
    const cmp = orderType === 'string' ? (cmpString as Comparator<unknown>) : (cmpNumber as Comparator<unknown>);
    return { def: full, cmp, groups: new Map(), byPk: new Map() };
  }

  create(name: string, def: CompoundIndexDef): void {
    if (this.indexes.has(name)) throw new Error(`compound index "${name}" already exists`);
    this.indexes.set(name, CompoundIndexManager.entry(def));
  }

  /** Stage a new compound index definition off to the side (see `staged`). */
  stage(name: string, def: CompoundIndexDef): void {
    if (this.indexes.has(name) || this.staged.has(name)) throw new Error(`compound index "${name}" already exists`);
    this.staged.set(name, CompoundIndexManager.entry(def));
  }

  /** Rebuild ONE staged index from entries of { key, value, dt }. Touches
   *  nothing live, so a failure midway leaves every published index intact. */
  rebuildStaged(name: string, entries: Iterable<{ key: string | Buffer; value: unknown; dt?: Record<string, number> | null }>): void {
    const entry = this.staged.get(name);
    if (!entry) throw new Error(`no staged compound index: ${name}`);
    for (const { key, value, dt } of entries) {
      this.addToEntry(entry, typeof key === 'string' ? key : Buffer.from(key).toString('binary'), value, dt ?? null);
    }
  }

  /** The staged definition in its persisted (CompoundIndexInfo) shape. */
  stagedInfo(name: string): CompoundIndexInfo {
    const e = this.staged.get(name);
    if (!e) throw new Error(`no staged compound index: ${name}`);
    return { name, groupBy: e.def.groupBy, orderBy: e.def.orderBy, orderType: e.def.orderType };
  }

  /** Move a staged index into the live registry (its sidecar persist already
   *  succeeded). */
  publish(name: string): void {
    const entry = this.staged.get(name);
    if (!entry) throw new Error(`no staged compound index: ${name}`);
    this.staged.delete(name);
    this.indexes.set(name, entry);
  }

  /** Drop a staged index without publishing it (the create failed). */
  discardStaged(name: string): void {
    this.staged.delete(name);
  }

  drop(name: string): boolean {
    return this.indexes.delete(name);
  }

  /** Live + staged count (a staged entry must be fed by the write paths
   *  exactly like a live one; see `staged`). */
  get size(): number {
    return this.indexes.size + this.staged.size;
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

  /** Add/update a document in one compound index entry. */
  private addToEntry(entry: CompoundEntry, pk: string, doc: unknown, dt: Record<string, number> | null): void {
    const { group, order } = this.extract(entry, doc, dt);
    const prev = entry.byPk.get(pk);
    const valid = group !== undefined && group !== null && this.validOrder(entry, order);

    // No-op when placement is unchanged. Without this guard, re-setting a key
    // with the same group+order inserted a duplicate skiplist node (and a
    // later delete left a phantom entry behind).
    if (prev && valid && prev.group === group && prev.order === order) return;

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

  /** Add/update a document across all compound indexes — live AND staged (a
   *  staged entry is kept exactly as current as the live ones, so publish()
   *  is a bare map move; see `staged`). */
  add(pk: string, doc: unknown, dt: Record<string, number> | null): void {
    for (const entry of this.indexes.values()) this.addToEntry(entry, pk, doc, dt);
    for (const entry of this.staged.values()) this.addToEntry(entry, pk, doc, dt);
  }

  remove(pk: string, _doc?: unknown, _dt?: Record<string, number> | null): void {
    for (const entry of this.indexes.values()) CompoundIndexManager.removeFromEntry(entry, pk);
    for (const entry of this.staged.values()) CompoundIndexManager.removeFromEntry(entry, pk);
  }

  private static removeFromEntry(entry: CompoundEntry, pk: string): void {
    const prev = entry.byPk.get(pk);
    if (prev) {
      const oldList = entry.groups.get(prev.group);
      if (oldList) oldList.delete(prev.order, pk);
      entry.byPk.delete(pk);
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
    const b = this.beginRebuild();
    for (const { key, value, dt } of entries) {
      b.add(typeof key === 'string' ? key : Buffer.from(key).toString('binary'), value, dt ?? null);
    }
    b.commit();
  }

  /** Stage a rebuild in fresh per-index state and swap it in on commit(), so
   *  a rebuild that fails midway leaves the previous indexes fully intact. */
  beginRebuild(): { add(pk: string, doc: unknown, dt: Record<string, number> | null): void; commit(): void } {
    const staged: { entry: CompoundEntry; next: CompoundEntry }[] = [];
    for (const entry of this.indexes.values()) {
      staged.push({ entry, next: { ...entry, groups: new Map(), byPk: new Map() } });
    }
    return {
      add: (pk, doc, dt) => {
        for (const { next } of staged) this.addToEntry(next, pk, doc, dt);
      },
      commit: () => {
        for (const { entry, next } of staged) {
          entry.groups = next.groups;
          entry.byPk = next.byPk;
        }
      },
    };
  }
}
