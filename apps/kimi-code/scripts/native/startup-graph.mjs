/**
 * Static reachability over the rolldown bundle's per-module init wrappers.
 *
 * rolldown emits one `//#region <source path>` block per module. A module that
 * is reachable through `import()` is wrapped as `var init_x = __esmMin(() => …)`
 * (CommonJS: `require_x = __commonJSMin(…)`) and only runs when someone calls
 * `init_x()`; the dynamic import itself becomes the lazy thunk
 * `Promise.resolve().then(() => (init_x(), x_exports))`. Modules on a purely
 * static path are emitted unwrapped and run at load time.
 *
 * So the modules evaluated at startup are every unwrapped region plus
 * everything reachable from them through eager `init_*()` / `require_*()`
 * calls. `checkStartupGraph` walks that set and rejects the bundle when a
 * module that must stay behind a dynamic import (the web server, the terminal
 * UI) has been pulled onto the startup path by a stray static import.
 */

const REGION_START = '//#region ';
const REGION_END = '//#endregion';
// `init_x = __esmMin(` for ES modules, `require_x = /* @__PURE__ */ __commonJSMin(` for CommonJS.
const WRAPPER_DEFINITION =
  /\b((?:init|require)_[A-Za-z0-9_$]+)\s*=\s*(?:\/\*[^*]*\*\/\s*)?(?:__esmMin|__commonJSMin)\(/g;
const WRAPPER_CALL = /\b((?:init|require)_[A-Za-z0-9_$]+)\(\)/g;
// Single-line lazy thunk rolldown emits for `import()`; calls inside it are
// deferred until the thunk runs.
const LAZY_THUNK = /Promise\.resolve\(\)\.then\(\(\)\s*=>[^\n]*?\)\)/g;

export const STARTUP_ENTRY_REGION = 'src/main.ts';

/** Modules that must only load once their command runs (`kimi web`, the shell). */
export const DEFERRED_STARTUP_MODULES = Object.freeze([
  // The search worker runtime is a deliberately tiny subpath export
  // (`@moonshot-ai/kap-server/search-worker-runtime`) that the CLI installs at
  // startup; everything else in the package is the server.
  {
    name: '@moonshot-ai/kap-server',
    pattern: /\/packages\/kap-server\/src\/(?!search\/worker\/runtime\.ts$)/,
  },
  { name: '@moonshot-ai/transcript', pattern: /\/packages\/transcript\/src\// },
  { name: '@moonshot-ai/pi-tui', pattern: /\/packages\/pi-tui\/src\// },
  { name: 'the terminal UI', pattern: /^src\/tui\/kimi-tui\.ts$/ },
  { name: 'cli-highlight', pattern: /\/node_modules\/cli-highlight\// },
  { name: 'lovely-mermaid', pattern: /\/node_modules\/lovely-mermaid\// },
]);

/** Split the bundle into `{ path, body }` regions (nested regions are flattened). */
export function parseBundleRegions(text) {
  const regions = [];
  const open = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith(REGION_START)) {
      open.push({ path: line.slice(REGION_START.length).trim(), start: index + 1 });
    } else if (line.startsWith(REGION_END)) {
      const region = open.pop();
      if (region !== undefined) {
        regions.push({ path: region.path, body: lines.slice(region.start, index) });
      }
    }
  }
  return regions;
}

/**
 * Regions evaluated at startup, with the region that first pulled each one in
 * (`via`) so a violation can be reported as an import chain.
 */
export function eagerStartupRegions(regions) {
  const definedIn = new Map();
  const eagerCalls = new Map();
  for (const region of regions) {
    const calls = new Set();
    for (const line of region.body) {
      if (line.startsWith('//')) continue;
      for (const match of line.matchAll(WRAPPER_DEFINITION)) definedIn.set(match[1], region.path);
      for (const match of line.replace(LAZY_THUNK, '').matchAll(WRAPPER_CALL)) calls.add(match[1]);
    }
    eagerCalls.set(region.path, calls);
  }
  const wrapped = new Set(definedIn.values());
  const reachable = new Set();
  const via = new Map();
  const queue = [];
  for (const region of regions) {
    if (wrapped.has(region.path) || reachable.has(region.path)) continue;
    reachable.add(region.path);
    queue.push(region.path);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const symbol of eagerCalls.get(current) ?? []) {
      const target = definedIn.get(symbol);
      if (target === undefined || reachable.has(target)) continue;
      reachable.add(target);
      via.set(target, current);
      queue.push(target);
    }
  }
  return { reachable, via };
}

function importChain(path, via) {
  const chain = [path];
  let current = via.get(path);
  while (current !== undefined && chain.length < 16) {
    chain.push(current);
    current = via.get(current);
  }
  return chain;
}

/**
 * Errors for every deferred module that the bundle evaluates at startup. An
 * unrecognisable bundle (no entry region) is an error too, so a change in
 * rolldown's output shape cannot turn the check into a silent pass.
 */
export function checkStartupGraph(
  text,
  { entry = STARTUP_ENTRY_REGION, deferred = DEFERRED_STARTUP_MODULES } = {},
) {
  const regions = parseBundleRegions(text);
  if (!regions.some((region) => region.path === entry)) {
    return [`startup graph: entry region ${entry} not found; region markers missing?`];
  }
  const { reachable, via } = eagerStartupRegions(regions);
  const errors = [];
  for (const { name, pattern } of deferred) {
    const hit = [...reachable].find((path) => pattern.test(path));
    if (hit === undefined) continue;
    errors.push(`${name} is evaluated at startup: ${importChain(hit, via).join(' <- ')}`);
  }
  return errors;
}
