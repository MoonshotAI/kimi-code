// src/query.ts
//
// A small, zero-dependency "jq / MongoDB-ish" query engine over JSON documents:
//   - path get/set/projection  (dot + bracket index: "a.b[0].c")
//   - filter predicates        (Mongo-like: { age: { $gt: 18 }, $or: [...] })
//   - sort / skip / limit

export type Doc = unknown;

type Path = string | readonly (string | number)[];

function tokenizePath(path: Path): (string | number)[] {
  if (Array.isArray(path)) return [...path];
  const tokens: (string | number)[] = [];
  for (const seg of String(path).split('.')) {
    let s = seg;
    while (s.length) {
      const m = s.match(/^([^[]*)\[(\d+)\](.*)$/);
      if (m) {
        if (m[1]) tokens.push(m[1]);
        tokens.push(Number(m[2]));
        s = m[3]!;
      } else {
        tokens.push(s);
        s = '';
      }
    }
  }
  return tokens;
}

export function getPath(doc: Doc, path: Path): unknown {
  let cur: unknown = doc;
  for (const t of tokenizePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

export function setPath(obj: Doc, path: Path, value: unknown): Doc {
  const tokens = tokenizePath(path);
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (cur[t] === null || cur[t] === undefined || typeof cur[t] !== 'object') {
      cur[t] = typeof tokens[i + 1] === 'number' ? [] : {};
    }
    cur = cur[t] as Record<string | number, unknown>;
  }
  cur[tokens[tokens.length - 1]!] = value;
  return obj;
}

/** Keep only the given paths (inclusion). Returns a new object. */
export function project(doc: Doc, paths?: readonly string[]): Doc {
  if (!paths || !paths.length) return doc;
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const v = getPath(doc, p);
    if (v !== undefined) setPath(out, p, v);
  }
  return out;
}

// --- filter --------------------------------------------------------------

type Cond = unknown;

function matchCond(val: unknown, cond: Cond): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof RegExp) {
    if (cond instanceof RegExp) {
      // A caller-supplied RegExp with the global/sticky flag is stateful:
      // .test() advances lastIndex. Reset it so every document is tested from
      // the start instead of alternating match/miss across documents.
      cond.lastIndex = 0;
      return typeof val === 'string' && cond.test(val);
    }
    return val === cond;
  }
  for (const op of Object.keys(cond as Record<string, unknown>)) {
    const arg = (cond as Record<string, unknown>)[op];
    switch (op) {
      case '$eq':
        if (val !== arg) return false;
        break;
      case '$ne':
        if (val === arg) return false;
        break;
      case '$gt':
        if (!((val as number) > (arg as number))) return false;
        break;
      case '$gte':
        if (!((val as number) >= (arg as number))) return false;
        break;
      case '$lt':
        if (!((val as number) < (arg as number))) return false;
        break;
      case '$lte':
        if (!((val as number) <= (arg as number))) return false;
        break;
      case '$in':
        if (!Array.isArray(arg) || !arg.includes(val)) return false;
        break;
      case '$nin':
        if (!Array.isArray(arg) || arg.includes(val)) return false;
        break;
      case '$regex': {
        const re =
          arg instanceof RegExp ? arg : Array.isArray(arg) ? new RegExp(arg[0] as string, arg[1] as string | undefined) : new RegExp(arg as string);
        if (typeof val !== 'string') return false;
        // Reset a stateful (global/sticky) RegExp so a reused instance does not
        // carry lastIndex over from the previous document.
        re.lastIndex = 0;
        if (!re.test(val)) return false;
        break;
      }
      case '$exists':
        if ((val !== undefined) !== !!arg) return false;
        break;
      case '$contains':
        if (!Array.isArray(val) || !val.includes(arg)) return false;
        break;
      case '$type':
        if (typeof val !== arg) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Does `doc` satisfy the Mongo-like `filter`? */
export function match(doc: Doc, filter?: Record<string, unknown> | null): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const key of Object.keys(filter)) {
    const cond = filter[key];
    if (key === '$and') {
      if (!Array.isArray(cond) || !cond.every((f) => match(doc, f as Record<string, unknown>))) return false;
    } else if (key === '$or') {
      if (!Array.isArray(cond) || !cond.some((f) => match(doc, f as Record<string, unknown>))) return false;
    } else if (key === '$nor') {
      if (!Array.isArray(cond) || cond.some((f) => match(doc, f as Record<string, unknown>))) return false;
    } else if (key === '$not') {
      if (match(doc, cond as Record<string, unknown>)) return false;
    } else {
      if (!matchCond(getPath(doc, key), cond)) return false;
    }
  }
  return true;
}

