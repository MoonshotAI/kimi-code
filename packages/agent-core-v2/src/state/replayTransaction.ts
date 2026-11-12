const RAW_TARGET = Symbol('replayTransactionRaw');

function isDraftableObject(
  value: unknown,
): value is Record<PropertyKey, unknown> | unknown[] | Map<unknown, unknown> | Set<unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function unwrapReplayDraft<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const raw = (value as Record<symbol, T | undefined>)[RAW_TARGET];
  return raw ?? value;
}

function cloneContainer<T>(value: T): T {
  if (!isDraftableObject(value)) return value;
  if (Array.isArray(value)) return [...value] as T;
  if (value instanceof Map) return new Map(value) as T;
  if (value instanceof Set) return new Set(value) as T;
  const proto = Object.getPrototypeOf(value) as object | null;
  return Object.defineProperties(
    Object.create(proto) as Record<PropertyKey, unknown>,
    Object.getOwnPropertyDescriptors(value),
  ) as T;
}

function cloneFrozenContainer<T>(value: T): T {
  return isDraftableObject(value) && Object.isFrozen(value) ? cloneContainer(value) : value;
}

function normalizeAssignedTree<T>(
  root: T,
  cleanCommitted: WeakSet<object>,
  seen: WeakSet<object>,
  cloneUnowned: boolean,
): T {
  const unwrapped = unwrapReplayDraft(root);
  if (!isDraftableObject(unwrapped)) return unwrapped;
  if (cleanCommitted.has(unwrapped) && !Object.isFrozen(unwrapped)) return unwrapped;
  const raw =
    cloneUnowned || Object.isFrozen(unwrapped) ? cloneContainer(unwrapped) : unwrapped;
  if (seen.has(raw)) return raw;
  seen.add(raw);
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) {
      const next = normalizeAssignedTree(raw[i], cleanCommitted, seen, cloneUnowned);
      if (next !== raw[i]) raw[i] = next;
    }
    cleanCommitted.add(raw);
    return raw;
  }
  if (raw instanceof Map) {
    const entries = [...raw.entries()];
    let changed = false;
    const nextEntries: Array<[unknown, unknown]> = [];
    for (const [k, v] of entries) {
      const nk = normalizeAssignedTree(k, cleanCommitted, seen, cloneUnowned);
      const nv = normalizeAssignedTree(v, cleanCommitted, seen, cloneUnowned);
      if (nk !== k || nv !== v) changed = true;
      nextEntries.push([nk, nv]);
    }
    if (changed) {
      raw.clear();
      for (const [k, v] of nextEntries) raw.set(k, v);
    }
    cleanCommitted.add(raw);
    return raw;
  }
  if (raw instanceof Set) {
    const items = [...raw.values()];
    let changed = false;
    const nextItems: unknown[] = [];
    for (const item of items) {
      const ni = normalizeAssignedTree(item, cleanCommitted, seen, cloneUnowned);
      if (ni !== item) changed = true;
      nextItems.push(ni);
    }
    if (changed) {
      raw.clear();
      for (const item of nextItems) raw.add(item);
    }
    cleanCommitted.add(raw);
    return raw;
  }
  const record = raw as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (desc !== undefined && 'value' in desc && desc.writable) {
      const next = normalizeAssignedTree(desc.value, cleanCommitted, seen, cloneUnowned);
      if (next !== desc.value) record[key] = next;
    }
  }
  cleanCommitted.add(raw);
  return raw;
}

export interface ReplayTransactionResult {
  readonly next: unknown;
  readonly mutated: boolean;
  readonly rollback: () => void;
}

export function applyReplayTransaction<S>(
  root: S,
  cleanCommitted: WeakSet<object>,
  fn: (draft: S) => unknown,
): ReplayTransactionResult {
  if (!isDraftableObject(root)) {
    const out = fn(root);
    const seen = new WeakSet<object>();
    return {
      next: out === undefined ? root : normalizeAssignedTree(out, cleanCommitted, seen, true),
      mutated: false,
      rollback: () => {},
    };
  }
  const proxies = new WeakMap<object, object>();
  const undo: Array<() => void> = [];
  const assignedSlots: Array<{ readonly apply: (seen: WeakSet<object>) => void }> = [];
  const wrap = <T>(target: T): T => {
    const raw = unwrapReplayDraft(target);
    if (!isDraftableObject(raw)) return raw;
    const existing = proxies.get(raw);
    if (existing !== undefined) return existing as T;
    const proxy = new Proxy(raw as object, {
      has(obj, prop) {
        return prop === RAW_TARGET || Reflect.has(obj, prop);
      },
      get(obj, prop, receiver) {
        if (prop === RAW_TARGET) return obj;
        if (Array.isArray(obj)) {
          if (prop === 'indexOf') {
            return (searchElement: unknown, fromIndex?: number) =>
              fromIndex === undefined
                ? obj.indexOf(unwrapReplayDraft(searchElement))
                : obj.indexOf(unwrapReplayDraft(searchElement), fromIndex);
          }
          if (prop === 'lastIndexOf') {
            return (searchElement: unknown, fromIndex?: number) =>
              fromIndex === undefined
                ? obj.lastIndexOf(unwrapReplayDraft(searchElement))
                : obj.lastIndexOf(unwrapReplayDraft(searchElement), fromIndex);
          }
          if (prop === 'includes') {
            return (searchElement: unknown, fromIndex?: number) =>
              fromIndex === undefined
                ? obj.includes(unwrapReplayDraft(searchElement))
                : obj.includes(unwrapReplayDraft(searchElement), fromIndex);
          }
        }
        if (obj instanceof Map) {
          if (prop === 'size') return obj.size;
          if (prop === 'get') return (k: unknown) => wrap(obj.get(unwrapReplayDraft(k)));
          if (prop === 'has') return (k: unknown) => obj.has(unwrapReplayDraft(k));
          if (prop === 'set') {
            return (k: unknown, v: unknown) => {
              const rk = cloneFrozenContainer(unwrapReplayDraft(k));
              const rv = cloneFrozenContainer(unwrapReplayDraft(v));
              const had = obj.has(rk);
              const old = obj.get(rk);
              undo.push(() => {
                if (had) obj.set(rk, old);
                else obj.delete(rk);
              });
              obj.set(rk, rv);
              assignedSlots.push({
                apply: (seen) => {
                  if (!obj.has(rk)) return;
                  const currentVal = obj.get(rk);
                  const nk = normalizeAssignedTree(rk, cleanCommitted, seen, true);
                  const nv = normalizeAssignedTree(currentVal, cleanCommitted, seen, true);
                  if (nk !== rk) {
                    obj.delete(rk);
                    obj.set(nk, nv);
                  } else if (nv !== currentVal) {
                    obj.set(rk, nv);
                  }
                },
              });
              return proxy;
            };
          }
          if (prop === 'delete') {
            return (k: unknown) => {
              const rk = unwrapReplayDraft(k);
              if (!obj.has(rk)) return false;
              const entries = [...obj.entries()];
              undo.push(() => {
                obj.clear();
                for (const [ek, ev] of entries) obj.set(ek, ev);
              });
              return obj.delete(rk);
            };
          }
          if (prop === 'clear') {
            return () => {
              if (obj.size === 0) return;
              const entries = [...obj.entries()];
              undo.push(() => {
                obj.clear();
                for (const [k, v] of entries) obj.set(k, v);
              });
              obj.clear();
            };
          }
          if (prop === 'forEach') {
            return (cb: (v: unknown, k: unknown, m: unknown) => void, thisArg?: unknown) => {
              obj.forEach((v, k) => {
                cb.call(thisArg, wrap(v), wrap(k), proxy);
              });
            };
          }
          if (prop === 'values') {
            return function* () {
              for (const v of obj.values()) yield wrap(v);
            };
          }
          if (prop === 'keys') {
            return function* () {
              for (const k of obj.keys()) yield wrap(k);
            };
          }
          if (prop === 'entries' || prop === Symbol.iterator) {
            return function* () {
              for (const [k, v] of obj.entries()) yield [wrap(k), wrap(v)] as [unknown, unknown];
            };
          }
          const val = Reflect.get(obj, prop, obj);
          return typeof val === 'function' ? val.bind(obj) : val;
        }
        if (obj instanceof Set) {
          if (prop === 'size') return obj.size;
          if (prop === 'has') return (v: unknown) => obj.has(unwrapReplayDraft(v));
          if (prop === 'add') {
            return (v: unknown) => {
              const rv = cloneFrozenContainer(unwrapReplayDraft(v));
              if (!obj.has(rv)) {
                undo.push(() => {
                  obj.delete(rv);
                });
              }
              obj.add(rv);
              assignedSlots.push({
                apply: (seen) => {
                  if (!obj.has(rv)) return;
                  const nv = normalizeAssignedTree(rv, cleanCommitted, seen, true);
                  if (nv !== rv) {
                    obj.delete(rv);
                    obj.add(nv);
                  }
                },
              });
              return proxy;
            };
          }
          if (prop === 'delete') {
            return (v: unknown) => {
              const rv = unwrapReplayDraft(v);
              if (!obj.has(rv)) return false;
              const items = [...obj.values()];
              undo.push(() => {
                obj.clear();
                for (const item of items) obj.add(item);
              });
              return obj.delete(rv);
            };
          }
          if (prop === 'clear') {
            return () => {
              if (obj.size === 0) return;
              const items = [...obj.values()];
              undo.push(() => {
                obj.clear();
                for (const v of items) obj.add(v);
              });
              obj.clear();
            };
          }
          if (prop === 'forEach') {
            return (cb: (v: unknown, v2: unknown, s: unknown) => void, thisArg?: unknown) => {
              obj.forEach((v) => {
                cb.call(thisArg, wrap(v), wrap(v), proxy);
              });
            };
          }
          if (prop === 'values' || prop === 'keys' || prop === Symbol.iterator) {
            return function* () {
              for (const v of obj.values()) yield wrap(v);
            };
          }
          if (prop === 'entries') {
            return function* () {
              for (const v of obj.values()) yield [wrap(v), wrap(v)] as [unknown, unknown];
            };
          }
          const val = Reflect.get(obj, prop, obj);
          return typeof val === 'function' ? val.bind(obj) : val;
        }
        const desc = Object.getOwnPropertyDescriptor(obj, prop);
        if (desc !== undefined && !desc.configurable && !desc.writable) {
          return Reflect.get(obj, prop, receiver);
        }
        return wrap(Reflect.get(obj, prop, obj));
      },
      set(obj, prop, value) {
        const rv = cloneFrozenContainer(unwrapReplayDraft(value));
        if (Array.isArray(obj) && prop === 'length') {
          const oldLen = obj.length;
          const newLen = Number(rv);
          if (newLen < oldLen) {
            const tail = obj.slice(newLen, oldLen);
            undo.push(() => {
              obj.length = newLen;
              for (let i = 0; i < tail.length; i += 1) obj[newLen + i] = tail[i];
            });
          } else if (newLen > oldLen) {
            undo.push(() => {
              obj.length = oldLen;
            });
          }
          obj.length = newLen;
          return true;
        }
        const rec = obj as Record<PropertyKey, unknown>;
        const had = Object.prototype.hasOwnProperty.call(obj, prop);
        const old = rec[prop];
        if (!had && Array.isArray(obj)) {
          const oldLen = obj.length;
          undo.push(() => {
            delete rec[prop];
            obj.length = oldLen;
          });
        } else {
          undo.push(() => {
            if (had) rec[prop] = old;
            else delete rec[prop];
          });
        }
        rec[prop] = rv;
        assignedSlots.push({
          apply: (seen) => {
            if (!Object.prototype.hasOwnProperty.call(obj, prop)) return;
            const cur = rec[prop];
            const next = normalizeAssignedTree(cur, cleanCommitted, seen, true);
            if (next !== cur) rec[prop] = next;
          },
        });
        return true;
      },
      deleteProperty(obj, prop) {
        const had = Object.prototype.hasOwnProperty.call(obj, prop);
        if (!had) return true;
        if (Array.isArray(obj)) {
          const rec = obj as unknown as Record<PropertyKey, unknown>;
          const old = rec[prop];
          undo.push(() => {
            rec[prop] = old;
          });
          return Reflect.deleteProperty(obj, prop);
        }
        const descriptors = Object.getOwnPropertyDescriptors(obj);
        undo.push(() => {
          for (const key of Reflect.ownKeys(obj)) {
            Reflect.deleteProperty(obj, key);
          }
          Object.defineProperties(obj, descriptors);
        });
        return Reflect.deleteProperty(obj, prop);
      },
      defineProperty(obj, prop, descriptor) {
        const cleanDesc =
          'value' in descriptor
            ? { ...descriptor, value: cloneFrozenContainer(unwrapReplayDraft(descriptor.value)) }
            : descriptor;
        const prev = Object.getOwnPropertyDescriptor(obj, prop);
        undo.push(() => {
          if (prev !== undefined) Object.defineProperty(obj, prop, prev);
          else Reflect.deleteProperty(obj, prop);
        });
        const ok = Reflect.defineProperty(obj, prop, cleanDesc);
        if (ok && 'value' in cleanDesc) {
          const rec = obj as Record<PropertyKey, unknown>;
          assignedSlots.push({
            apply: (seen) => {
              const curDesc = Object.getOwnPropertyDescriptor(obj, prop);
              if (curDesc === undefined || !('value' in curDesc) || !curDesc.writable) return;
              const next = normalizeAssignedTree(curDesc.value, cleanCommitted, seen, true);
              if (next !== curDesc.value) rec[prop] = next;
            },
          });
        }
        return ok;
      },
    });
    proxies.set(raw, proxy);
    return proxy as T;
  };
  let rolledBack = false;
  const rollback = (): void => {
    if (rolledBack) return;
    rolledBack = true;
    for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
    undo.length = 0;
  };
  try {
    normalizeAssignedTree(root, cleanCommitted, new WeakSet<object>(), false);
    const out = fn(wrap(root));
    const seen = new WeakSet<object>();
    for (const slot of assignedSlots) slot.apply(seen);
    const next = out === undefined ? root : normalizeAssignedTree(out, cleanCommitted, seen, true);
    return { next, mutated: undo.length > 0, rollback };
  } catch (error) {
    rollback();
    throw error;
  }
}
