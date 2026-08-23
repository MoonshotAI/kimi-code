/**
 * Generates a black-box "contract" declaration tree for agent-core-v2.
 *
 * The output mirrors `src/` but with every registered service IMPLEMENTATION
 * class removed, leaving only the contract surface: interfaces, types, models,
 * error domains, factory functions, the `ServiceIdentifier` accessors, and the
 * DI primitives. Consumers (kimi-code-mini-bench) type-check against this tree
 * so tests cannot import an impl class, while at runtime the real linked
 * package still binds the real implementations.
 *
 * Pipeline:
 *   1. `tsc --emitDeclarationOnly` over `src/` into a temp dir.
 *   2. Detect impl files = source files containing a top-level
 *      `registerScopedService(...)` call; the 3rd argument is the impl class.
 *   3. In each impl file's emitted `.d.ts`, drop the registered class
 *      declaration(s) and keep everything else, then drop re-export
 *      specifiers elsewhere in the tree that name a dropped class
 *      (deprecated alias modules) — they would otherwise dangle.
 *   4. Copy the scrubbed tree to the output directory.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { Project, SyntaxKind } from 'ts-morph';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, '..'); // packages/agent-core-v2
const SRC = join(PKG, 'src');
const TMP = join(PKG, '.contract-types-tmp');
const TSCONFIG = join(PKG, 'tsconfig.contract.json');

const repoRoot = join(PKG, '..', '..');
const defaultOut = join(repoRoot, '..', 'kimi-code-mini-bench', 'types', 'agent-core-v2');
const OUT = process.argv[2] ? join(process.cwd(), process.argv[2]) : defaultOut;

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');

function log(msg) {
  console.log(`[gen-contract-types] ${msg}`);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

// 1. Emit declarations for the whole src tree.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
log(`emitting declarations via tsc -> ${relative(PKG, TMP)}`);
// tsc exits non-zero on the repo's pre-existing type errors (WIP port), but
// still emits `.d.ts` for every file when `noEmitOnError` is off. We only need
// the declarations, so tolerate a non-zero exit and continue.
try {
  execFileSync(process.execPath, [tscBin, '-p', TSCONFIG, '--outDir', TMP], {
    cwd: PKG,
    stdio: 'pipe',
  });
} catch (err) {
  const code = err && typeof err === 'object' && 'status' in err ? err.status : 'unknown';
  log(`tsc exited ${String(code)} (non-fatal; declarations are still emitted)`);
}

// 2. Detect impl files + registered class names (AST only).
log('scanning for registerScopedService(...) bindings');
const project = new Project();
project.addSourceFilesAtPaths(join(SRC, '**', '*.ts'));

/** @type {Map<string, Set<string>>} dtsPath -> class names to drop */
const dropByDts = new Map();
const implFiles = [];

for (const sf of project.getSourceFiles()) {
  const calls = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === 'registerScopedService');
  if (calls.length === 0) continue;

  implFiles.push(sf.getFilePath());
  const names = new Set();
  for (const call of calls) {
    const args = call.getArguments();
    if (args.length < 3) continue;
    const text = args[2].getText().trim();
    // Only treat a bare identifier as a class name; otherwise signal "drop all".
    names.add(/^[A-Za-z_$][\w$]*$/.test(text) ? text : '*');
  }

  const rel = relative(SRC, sf.getFilePath()).replace(/\.ts$/, '.d.ts');
  const dtsPath = join(TMP, rel);
  const existing = dropByDts.get(dtsPath) ?? new Set();
  for (const n of names) existing.add(n);
  dropByDts.set(dtsPath, existing);
}

log(`found ${implFiles.length} impl files`);

// 3. Scrub registered classes from each impl .d.ts.
let scrubbedFiles = 0;
let scrubbedClasses = 0;
for (const [dtsPath, names] of dropByDts) {
  if (!existsSync(dtsPath)) continue;
  const dtsProject = new Project();
  const dts = dtsProject.addSourceFileAtPath(dtsPath);
  const dropAll = names.has('*');
  let removed = 0;
  for (const cls of dts.getClasses()) {
    const clsName = cls.getName();
    if (dropAll || (clsName !== undefined && names.has(clsName))) {
      cls.remove();
      removed++;
    }
  }
  if (removed > 0) {
    dts.saveSync();
    scrubbedFiles++;
    scrubbedClasses += removed;
  }
}
log(`scrubbed ${scrubbedClasses} impl class(es) across ${scrubbedFiles} file(s)`);

// 3b. Scrub re-exports of scrubbed classes. A deprecated alias module (e.g.
// `export { Impl as OldName } from './implService'`) would otherwise keep
// naming a class its declaring file no longer exports — a dangling reference
// for consumers and an impl-name leak. `export *` needs nothing: it only
// re-exports what survives.
function resolveReexportTarget(dtsPath, spec) {
  const clean = spec.endsWith('.js') ? spec.slice(0, -'.js'.length) : spec;
  if (clean.startsWith('.')) return join(dirname(dtsPath), `${clean}.d.ts`);
  if (clean.startsWith('#/')) return join(TMP, `${clean.slice(2)}.d.ts`);
  return undefined;
}

let scrubbedReexports = 0;
const emittedDts = [];
walk(TMP, emittedDts);
const reexportProject = new Project();
for (const dtsPath of emittedDts) {
  if (!dtsPath.endsWith('.d.ts')) continue;
  const dts = reexportProject.addSourceFileAtPath(dtsPath);
  let changed = false;
  for (const exp of dts.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec === undefined) continue;
    const target = resolveReexportTarget(dtsPath, spec);
    const names = target === undefined ? undefined : dropByDts.get(target);
    if (names === undefined) continue;
    let removedHere = false;
    for (const specifier of exp.getNamedExports()) {
      const name = specifier.getNameNode().getText();
      if (names.has('*') || names.has(name)) {
        specifier.remove();
        removedHere = true;
        scrubbedReexports++;
      }
    }
    if (removedHere && exp.getNamedExports().length === 0) exp.remove();
    changed = changed || removedHere;
  }
  if (changed) dts.saveSync();
}
log(`scrubbed ${scrubbedReexports} re-export(s) of impl classes from alias modules`);

// 4. Copy the scrubbed tree to the output directory.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
cpSync(TMP, OUT, { recursive: true });

// Sanity summary: report emitted files + a quick leak check (any impl class
// name still declared in its own file).
const emitted = [];
walk(OUT, emitted);
const dtsCount = emitted.filter((f) => f.endsWith('.d.ts')).length;
log(`wrote ${dtsCount} declaration file(s) -> ${OUT}`);

// Verify no registered class name survives in the file that registered it.
const leaks = [];
for (const [dtsPath, names] of dropByDts) {
  const outPath = join(OUT, relative(TMP, dtsPath));
  if (!existsSync(outPath) || names.has('*')) continue;
  const text = readFileSync(outPath, 'utf8');
  for (const n of names) {
    const re = new RegExp(`declare\\s+class\\s+${n}\\b`);
    if (re.test(text)) leaks.push(`${relative(OUT, outPath)} still declares ${n}`);
  }
}
if (leaks.length > 0) {
  log(`WARNING: ${leaks.length} possible leak(s):`);
  for (const l of leaks) log(`  - ${l}`);
} else {
  log('leak check passed: no registered impl class survives in its declaring file');
}
