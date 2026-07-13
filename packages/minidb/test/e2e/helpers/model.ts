// test/e2e/helpers/model.js
// A minimal reference model of the KV semantics, used by the model-based fuzz
// test. It mirrors what MiniDb should do with plain JS structures.

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export class Model {
  constructor() {
    this.map = new Map(); // key -> { value, expireAt }
  }

  _purge(k, r) {
    if (r.expireAt && r.expireAt <= Date.now()) {
      this.map.delete(k);
      return true;
    }
    return false;
  }

  set(key, value, ttl) {
    this.map.set(key, { value: clone(value), expireAt: ttl ? Date.now() + ttl : 0 });
  }

  get(key) {
    const r = this.map.get(key);
    if (!r) return undefined;
    if (this._purge(key, r)) return undefined;
    return r.value;
  }

  del(key) {
    return this.map.delete(key);
  }

  expire(key, ttl) {
    const r = this.map.get(key);
    if (!r || this._purge(key, r)) return false;
    r.expireAt = Date.now() + ttl;
    return true;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  // Live (non-expired) keys at this instant.
  liveKeys() {
    const out = [];
    for (const k of this.map.keys()) if (this.get(k) !== undefined) out.push(k);
    return out.sort();
  }
}
