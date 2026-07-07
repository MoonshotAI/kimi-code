// src/skiplist.ts
//
// A comparator-driven skip list (Redis zskiplist, generalized). Nodes are
// ordered by a sort `key` with a deterministic tie-break on `val`; the `span`
// field on each level gives O(log N) rank access and efficient range scans.

const MAX_LEVEL = 32;
const P = 0.25;

export type Comparator<T> = (a: T, b: T) => number;

export const cmpNumber: Comparator<number> = (a, b) => a - b;
export const cmpString: Comparator<string> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function randomLevel(): number {
  let lvl = 1;
  while (Math.random() < P && lvl < MAX_LEVEL) lvl++;
  return lvl;
}

interface Level<K, V> {
  forward: SkipNode<K, V> | null;
  span: number;
}

class SkipNode<K, V> {
  key: K;
  val: V;
  backward: SkipNode<K, V> | null = null;
  level: Level<K, V>[];

  constructor(key: K, val: V, level: number) {
    this.key = key;
    this.val = val;
    this.level = Array.from({ length: level }, () => ({ forward: null, span: 0 }));
  }
}

export interface SkipListOptions<K, V> {
  compareKey?: Comparator<K>;
  compareVal?: Comparator<V>;
}

export interface RangeOptions<K> {
  gte?: K;
  gt?: K;
  lte?: K;
  lt?: K;
  offset?: number;
  count?: number;
  reverse?: boolean;
}

export interface RangeEntry<K, V> {
  key: K;
  val: V;
}

export class SkipList<K = number, V = string> {
  private readonly cmpK: Comparator<K>;
  private readonly cmpV: Comparator<V>;
  private readonly header: SkipNode<K, V>;
  private tail: SkipNode<K, V> | null = null;
  length = 0;
  private level = 1;

  constructor(opts: SkipListOptions<K, V> = {}) {
    this.cmpK = opts.compareKey ?? (cmpNumber as unknown as Comparator<K>);
    this.cmpV = opts.compareVal ?? (cmpString as unknown as Comparator<V>);
    this.header = new SkipNode<K, V>(undefined as unknown as K, undefined as unknown as V, MAX_LEVEL);
  }

  private nodeLess(a: SkipNode<K, V>, b: { key: K; val: V }): boolean {
    const c = this.cmpK(a.key, b.key);
    return c < 0 || (c === 0 && this.cmpV(a.val, b.val) < 0);
  }

  insert(key: K, val: V): SkipNode<K, V> {
    const update = Array.from<SkipNode<K, V>>({ length: MAX_LEVEL });
    const rank = Array.from({ length: MAX_LEVEL }, () => 0);
    let x: SkipNode<K, V> = this.header;
    const target = { key, val };

    for (let i = this.level - 1; i >= 0; i--) {
      rank[i] = i === this.level - 1 ? 0 : rank[i + 1]!;
      let f = x.level[i]!.forward;
      while (f && this.nodeLess(f, target)) {
        rank[i]! += x.level[i]!.span;
        x = f;
        f = x.level[i]!.forward;
      }
      update[i] = x;
    }

    let lvl = randomLevel();
    if (lvl > this.level) {
      for (let i = this.level; i < lvl; i++) {
        rank[i] = 0;
        update[i] = this.header;
        update[i]!.level[i]!.span = this.length;
      }
      this.level = lvl;
    }

    x = new SkipNode<K, V>(key, val, lvl);
    for (let i = 0; i < lvl; i++) {
      x.level[i]!.forward = update[i]!.level[i]!.forward;
      update[i]!.level[i]!.forward = x;
      x.level[i]!.span = update[i]!.level[i]!.span - (rank[0]! - rank[i]!);
      update[i]!.level[i]!.span = rank[0]! - rank[i]! + 1;
    }
    for (let i = lvl; i < this.level; i++) update[i]!.level[i]!.span++;

    x.backward = update[0] === this.header ? null : update[0]!;
    if (x.level[0]!.forward) x.level[0]!.forward.backward = x;
    else this.tail = x;
    this.length++;
    return x;
  }

  private deleteNode(x: SkipNode<K, V>, update: SkipNode<K, V>[]): void {
    for (let i = 0; i < this.level; i++) {
      if (update[i]!.level[i]!.forward === x) {
        update[i]!.level[i]!.span += x.level[i]!.span - 1;
        update[i]!.level[i]!.forward = x.level[i]!.forward;
      } else {
        update[i]!.level[i]!.span--;
      }
    }
    if (x.level[0]!.forward) x.level[0]!.forward.backward = x.backward;
    else this.tail = x.backward;
    while (this.level > 1 && this.header.level[this.level - 1]!.forward === null) this.level--;
    this.length--;
  }

  delete(key: K, val: V): boolean {
    const update = Array.from<SkipNode<K, V>>({ length: MAX_LEVEL });
    let x: SkipNode<K, V> = this.header;
    const target = { key, val };
    for (let i = this.level - 1; i >= 0; i--) {
      let f = x.level[i]!.forward;
      while (f && this.nodeLess(f, target)) {
        x = f;
        f = x.level[i]!.forward;
      }
      update[i] = x;
    }
    const last = x.level[0]!.forward;
    if (last && this.cmpK(last.key, key) === 0 && this.cmpV(last.val, val) === 0) {
      this.deleteNode(last, update);
      return true;
    }
    return false;
  }

  /** First node with key >= bound (or > bound if strict). */
  lowerBound(bound: K, { strict = false }: { strict?: boolean } = {}): SkipNode<K, V> | null {
    let x: SkipNode<K, V> = this.header;
    for (let i = this.level - 1; i >= 0; i--) {
      let f: SkipNode<K, V> | null;
      while (
        (f = x.level[i]!.forward) &&
        (strict ? this.cmpK(f.key, bound) <= 0 : this.cmpK(f.key, bound) < 0)
      ) {
        x = f;
      }
    }
    return x.level[0]!.forward;
  }

  /** 0-based rank of (key, val), or null if absent. */
  getRank(key: K, val: V): number | null {
    let x: SkipNode<K, V> = this.header;
    let rank = 0;
    const target = { key, val };
    for (let i = this.level - 1; i >= 0; i--) {
      let f = x.level[i]!.forward;
      while (f && (this.nodeLess(f, target) || (this.cmpK(f.key, key) === 0 && this.cmpV(f.val, val) === 0))) {
        rank += x.level[i]!.span;
        x = f;
        f = x.level[i]!.forward;
      }
    }
    if (x !== this.header && this.cmpK(x.key, key) === 0 && this.cmpV(x.val, val) === 0) return rank - 1;
    return null;
  }

  /** Node at 0-based rank, or null. */
  getByRank(rank: number): RangeEntry<K, V> | null {
    if (rank < 0 || rank >= this.length) return null;
    const target = rank + 1;
    let x: SkipNode<K, V> = this.header;
    let traversed = 0;
    for (let i = this.level - 1; i >= 0; i--) {
      let f = x.level[i]!.forward;
      while (f && traversed + x.level[i]!.span <= target) {
        traversed += x.level[i]!.span;
        x = f;
        f = x.level[i]!.forward;
      }
      if (traversed === target) return { key: x.key, val: x.val };
    }
    return null;
  }

  /** Range scan. */
  range(opts: RangeOptions<K> = {}): RangeEntry<K, V>[] {
    let offset = opts.offset ?? 0;
    let count = opts.count ?? Infinity;
    const out: RangeEntry<K, V>[] = [];

    if (opts.reverse) {
      let x: SkipNode<K, V> | null;
      if (opts.lte !== undefined) {
        const after = this.lowerBound(opts.lte, { strict: true });
        x = after ? after.backward : this.tail;
      } else if (opts.lt !== undefined) {
        const after = this.lowerBound(opts.lt, { strict: false });
        x = after ? after.backward : this.tail;
      } else {
        x = this.tail;
      }
      while (x) {
        if (opts.gte !== undefined && this.cmpK(x.key, opts.gte) < 0) break;
        if (opts.gt !== undefined && this.cmpK(x.key, opts.gt) <= 0) break;
        if (offset > 0) offset--;
        else if (count > 0) {
          out.push({ key: x.key, val: x.val });
          count--;
        } else break;
        x = x.backward;
      }
      return out;
    }

    const hasLower = opts.gte !== undefined || opts.gt !== undefined;
    let x = hasLower
      ? this.lowerBound(opts.gte !== undefined ? opts.gte : (opts.gt as K), { strict: opts.gt !== undefined })
      : this.header.level[0]!.forward;
    while (x) {
      if (opts.lte !== undefined && this.cmpK(x.key, opts.lte) > 0) break;
      if (opts.lt !== undefined && this.cmpK(x.key, opts.lt) >= 0) break;
      if (offset > 0) offset--;
      else if (count > 0) {
        out.push({ key: x.key, val: x.val });
        count--;
      } else break;
      x = x.level[0]!.forward;
    }
    return out;
  }

  /** Lazy range scan. Same bounds/offset/count/reverse semantics as range(),
   *  but yields entries one by one so a caller can stop early without
   *  materializing the whole range. */
  *iterate(opts: RangeOptions<K> = {}): Generator<RangeEntry<K, V>> {
    let offset = opts.offset ?? 0;
    let count = opts.count ?? Infinity;

    if (opts.reverse) {
      let x: SkipNode<K, V> | null;
      if (opts.lte !== undefined) {
        const after = this.lowerBound(opts.lte, { strict: true });
        x = after ? after.backward : this.tail;
      } else if (opts.lt !== undefined) {
        const after = this.lowerBound(opts.lt, { strict: false });
        x = after ? after.backward : this.tail;
      } else {
        x = this.tail;
      }
      while (x) {
        if (opts.gte !== undefined && this.cmpK(x.key, opts.gte) < 0) break;
        if (opts.gt !== undefined && this.cmpK(x.key, opts.gt) <= 0) break;
        if (offset > 0) offset--;
        else if (count > 0) {
          yield { key: x.key, val: x.val };
          count--;
        } else break;
        x = x.backward;
      }
      return;
    }

    const hasLower = opts.gte !== undefined || opts.gt !== undefined;
    let x = hasLower
      ? this.lowerBound(opts.gte !== undefined ? opts.gte : (opts.gt as K), { strict: opts.gt !== undefined })
      : this.header.level[0]!.forward;
    while (x) {
      if (opts.lte !== undefined && this.cmpK(x.key, opts.lte) > 0) break;
      if (opts.lt !== undefined && this.cmpK(x.key, opts.lt) >= 0) break;
      if (offset > 0) offset--;
      else if (count > 0) {
        yield { key: x.key, val: x.val };
        count--;
      } else break;
      x = x.level[0]!.forward;
    }
  }

  toArray(): RangeEntry<K, V>[] {
    const out: RangeEntry<K, V>[] = [];
    let x = this.header.level[0]!.forward;
    while (x) {
      out.push({ key: x.key, val: x.val });
      x = x.level[0]!.forward;
    }
    return out;
  }
}
