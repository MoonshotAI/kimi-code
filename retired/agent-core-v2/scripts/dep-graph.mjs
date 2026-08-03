#!/usr/bin/env node
/**
 * Dump the agent-core-v2 Service dependency graph.
 *
 * Walks every `src/<domain>/*Service.ts` impl file, and for each registered
 * service extracts:
 *  - its `LifecycleScope` (from the `registerScopedService(...)` call),
 *  - its constructor DI dependencies (the `@IToken` parameter decorators).
 *
 * Output is grouped by domain so the whole graph can be reviewed in one pass.
 *
 * Run: `node scripts/dep-graph.mjs`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

const SCOPE_DIRS = new Set(['app', 'session', 'agent']);

/** Resolve a `src/`-relative file path to its domain, skipping the scope tier. */
function domainOf(rel) {
  const segments = rel.split(/[\\/]/);
  return SCOPE_DIRS.has(segments[0]) ? segments[1] : segments[0];
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith('.ts') && entry !== 'index.ts') out.push(abs);
  }
  return out;
}

/**
 * Extract services from one impl file.
 * @returns {Array<{impl:string, token:string, scope:string, deps:string[]}>}
 */
function extract(source) {
  const services = [];

  // Map impl class -> ctor deps (via @IToken decorators in the constructor).
  const classRe = /export\s+class\s+(\w+)\s*(?:extends\s+\w+\s*)?(?:implements\s+[\w,\s]+)?\s*\{/g;
  let cls;
  const classDeps = new Map();
  while ((cls = classRe.exec(source)) !== null) {
    const impl = cls[1];
    const start = cls.index;
    // Find the constructor belonging to this class (before the next top-level class).
    const nextClass = classRe.exec(source);
    classRe.lastIndex = cls.index + 1; // allow re-match
    const slice = source.slice(start, nextClass ? nextClass.index : source.length);
    if (nextClass) classRe.lastIndex = nextClass.index;
    const ctorMatch = /constructor\s*\(([^)]*)\)/.exec(slice);
    const deps = [];
    if (ctorMatch) {
      const decRe = /@(I[A-Za-z]\w*)\s+(?:(?:private|protected|public|readonly)\s+)*_?\w+\s*:/g;
      let d;
      while ((d = decRe.exec(ctorMatch[1])) !== null) deps.push(d[1]);
    }
    classDeps.set(impl, deps);
  }

  // Pair each registerScopedService call with scope + token + impl.
  const regRe =
    /registerScopedService\(\s*LifecycleScope\.(\w+)\s*,\s*(I[A-Za-z]\w*)\s*,\s*(\w+)\s*,/g;
  let r;
  while ((r = regRe.exec(source)) !== null) {
    const [, scope, token, impl] = r;
    services.push({
      impl,
      token,
      scope,
      deps: classDeps.get(impl) ?? [],
    });
  }
  return services;
}

function main() {
  const files = walk(SRC_ROOT);
  /** @type {Map<string, Array<{impl:string,token:string,scope:string,deps:string[]}>>} */
  const byDomain = new Map();
  for (const f of files) {
    const domain = domainOf(relative(SRC_ROOT, f));
    const services = extract(readFileSync(f, 'utf8'));
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(...services);
  }

  const domains = [...byDomain.keys()].sort();
  let total = 0;
  for (const domain of domains) {
    const services = byDomain.get(domain).sort((a, b) => a.token.localeCompare(b.token));
    console.log(`\n## ${domain}`);
    for (const s of services) {
      total++;
      const deps = s.deps.length > 0 ? s.deps.join(', ') : '—';
      console.log(`- ${s.token} [${s.scope}] → ${deps}`);
    }
  }
  console.log(`\n${total} services across ${domains.length} domains.`);
  return 0;
}

process.exit(main());
