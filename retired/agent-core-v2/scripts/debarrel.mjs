#!/usr/bin/env node
/**
 * debarrel.mjs — agent-core-v2 barrel removal tool (ts-morph).
 *
 * Rewrites `#/<dir>` barrel imports/exports to precise leaf-file specifiers and
 * regenerates the package entry `src/index.ts` so it loads every domain leaf
 * (triggering all top-level `register*` side effects) without domain barrels.
 *
 * Modes:
 *   (default)          rewrite all consumer files (src + test) EXCEPT src/index.ts
 *   --only=<reldir>    limit consumer rewriting to one barrel, e.g. app/event
 *   --entry            regenerate src/index.ts only (no consumer rewriting)
 *   --delete-barrels   delete every domain barrel (per-domain src index.ts except entry)
 *   --list-registers   print the top-level register* files (coverage set)
 *   --verify-coverage  exit non-zero if any register file is unreachable from entry
 *   --dry-run          report planned edits without writing
 */
import { Project } from 'ts-morph';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'src');
const ENTRY = path.join(SRC, 'index.ts');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;
const ENTRY_ONLY = args.includes('--entry');
const DELETE_BARRELS = args.includes('--delete-barrels');
const LIST_REGS = args.includes('--list-registers');
const VERIFY = args.includes('--verify-coverage');

const project = new Project({ tsConfigFilePath: path.join(PKG, 'tsconfig.json') });

const relSpec = (absFile) =>
  '#/' + path.relative(SRC, absFile).split(path.sep).join('/').replace(/\.ts$/, '');

const isUnderSrc = (abs) => abs === SRC || abs.startsWith(SRC + path.sep);
const isIndexBasename = (abs) => path.basename(abs) === 'index.ts';
const isBarrelFile = (sf) => {
  const f = sf.getFilePath();
  return isUnderSrc(f) && isIndexBasename(f) && f !== ENTRY;
};
const resolvedFile = (decl) => decl.getModuleSpecifierSourceFile() || null;
const barrelOfDecl = (decl) => {
  const sf = resolvedFile(decl);
  return sf && isBarrelFile(sf) ? sf : null;
};

// Resolve a name exported by `barrel` to the leaf file that declares it and the
// name that leaf uses to export it (handles `export { A as B }` at barrel level).
function resolveName(barrel, name) {
  const decls = barrel.getExportedDeclarations().get(name);
  if (!decls || decls.length === 0) return null;
  const decl = decls[0];
  const leaf = decl.getSourceFile();
  const sym = decl.getSymbol();
  let leafName = null;
  for (const [ln, lds] of leaf.getExportedDeclarations()) {
    if (lds.some((d) => d.getSymbol() === sym)) {
      leafName = ln;
      break;
    }
  }
  if (leafName === null) leafName = (sym && sym.getName()) || name;
  return { leafFile: leaf.getFilePath(), leafName };
}

// Ordered re-export clauses of a barrel (recursively inlines nested barrels),
// preserving source order so `export *` collision resolution is unchanged.
function expandBarrelClauses(barrel) {
  const clauses = [];
  for (const ed of barrel.getExportDeclarations()) {
    const target = resolvedFile(ed);
    if (!target) continue;
    if (isBarrelFile(target)) {
      clauses.push(...expandBarrelClauses(target));
      continue;
    }
    const file = target.getFilePath();
    const isStar =
      ed.getNamedExports().length === 0 && !ed.getNamespaceExport();
    if (isStar) {
      clauses.push({ kind: 'star', file });
    } else if (ed.getNamespaceExport()) {
      clauses.push({ kind: 'namespace', file, name: ed.getNamespaceExport().getName() });
    } else {
      const declType = ed.isTypeOnly();
      const specs = ed.getNamedExports().map((s) => ({
        name: s.getName(),
        alias: s.getAliasNode()?.getText(),
        isTypeOnly: declType || s.isTypeOnly(),
      }));
      clauses.push({ kind: 'named', file, isTypeOnly: declType, specs });
    }
  }
  return clauses;
}

function allLeavesUnderDir(dirAbs) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (
        ent.isFile() &&
        p.endsWith('.ts') &&
        !p.endsWith('.test.ts') &&
        !p.endsWith('.d.ts') &&
        path.basename(p) !== 'index.ts'
      ) {
        out.push(p);
      }
    }
  };
  walk(dirAbs);
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Consumer rewriting (imports + named exports + export *) for a single file.
// ---------------------------------------------------------------------------
function rewriteConsumerFile(sf, onlyBarrelPath) {
  const report = { imports: 0, exports: 0, manuals: [], sideEffects: 0 };

  // Imports.
  for (const decl of sf.getImportDeclarations()) {
    const barrel = barrelOfDecl(decl);
    if (!barrel) continue;
    if (onlyBarrelPath && barrel.getFilePath() !== onlyBarrelPath) continue;

    if (decl.getNamespaceImport()) {
      report.manuals.push({ sf: sf.getFilePath(), text: decl.getText(), why: 'namespace import' });
      continue;
    }
    const hasDefault = !!decl.getDefaultImport();
    const named = decl.getNamedImports();
    if (!hasDefault && named.length === 0) {
      // side-effect: import '#/B' -> load each leaf of B.
      const leaves = [...new Set(expandBarrelClauses(barrel).map((c) => c.file))];
      const idx = sf.getImportDeclarations().indexOf(decl);
      sf.insertImportDeclarations(
        idx,
        leaves.map((leaf) => ({ moduleSpecifier: relSpec(leaf) })),
      );
      decl.remove();
      report.sideEffects += leaves.length;
      report.imports++;
      continue;
    }

    const declType = decl.isTypeOnly();
    const groups = new Map(); // leafFile -> [{name, alias, isTypeOnly}]
    const add = (leaf, spec) => {
      if (!groups.has(leaf)) groups.set(leaf, []);
      groups.get(leaf).push(spec);
    };

    if (hasDefault) {
      const r = resolveName(barrel, 'default');
      if (!r) report.manuals.push({ sf: sf.getFilePath(), text: decl.getText(), why: 'default import unresolved' });
      else add(r.leafFile, { default: decl.getDefaultImport().getText() });
    }
    for (const s of named) {
      const lookup = s.getName(); // module-exported name
      const local = s.getAliasNode()?.getText() || s.getName();
      const r = resolveName(barrel, lookup);
      if (!r) {
        report.manuals.push({ sf: sf.getFilePath(), text: s.getText(), why: 'named import unresolved' });
        continue;
      }
      add(r.leafFile, {
        name: r.leafName,
        alias: local !== r.leafName ? local : undefined,
        isTypeOnly: declType || s.isTypeOnly(),
      });
    }
    const structures = buildImportStructures(groups);
    const idx = sf.getImportDeclarations().indexOf(decl);
    if (structures.length) sf.insertImportDeclarations(idx, structures);
    decl.remove();
    report.imports++;
  }

  // Exports.
  for (const decl of sf.getExportDeclarations()) {
    const barrel = barrelOfDecl(decl);
    if (!barrel) continue;
    if (onlyBarrelPath && barrel.getFilePath() !== onlyBarrelPath) continue;

    const isStar = decl.getNamedExports().length === 0 && !decl.getNamespaceExport();
    if (isStar) {
      const clauses = expandBarrelClauses(barrel);
      decl.replaceWithText(clauses.map(exportClauseToText).join('\n'));
      report.exports++;
      continue;
    }
    if (decl.getNamespaceExport()) {
      report.manuals.push({ sf: sf.getFilePath(), text: decl.getText(), why: 'namespace export' });
      continue;
    }
    // named re-export
    const declType = decl.isTypeOnly();
    const groups = new Map();
    for (const s of decl.getNamedExports()) {
      const lookup = s.getName(); // name the consumer re-exports (= barrel's exported name)
      const exportedAs = s.getAliasNode()?.getText() || s.getName();
      const r = resolveName(barrel, lookup);
      if (!r) {
        report.manuals.push({ sf: sf.getFilePath(), text: s.getText(), why: 'named export unresolved' });
        continue;
      }
      if (!groups.has(r.leafFile)) groups.set(r.leafFile, { specs: [], allType: true });
      const g = groups.get(r.leafFile);
      const t = declType || s.isTypeOnly();
      g.allType = g.allType && t;
      g.specs.push({
        name: r.leafName,
        alias: exportedAs !== r.leafName ? exportedAs : undefined,
        isTypeOnly: t,
      });
    }
    const lines = [];
    for (const [leaf, { specs, allType }] of groups) {
      lines.push(renderNamedExport(relSpec(leaf), specs, allType));
    }
    decl.replaceWithText(lines.join('\n'));
    report.exports++;
  }
  return report;
}

function buildImportStructures(groups) {
  const structures = [];
  for (const [leaf, specs] of groups) {
    const spec = relSpec(leaf);
    const defaults = specs.filter((s) => s.default);
    const namedSpecs = specs.filter((s) => !s.default);
    for (const d of defaults) {
      structures.push({ moduleSpecifier: spec, defaultImport: d.default });
    }
    const values = namedSpecs.filter((s) => !s.isTypeOnly);
    const types = namedSpecs.filter((s) => s.isTypeOnly);
    if (values.length)
      structures.push({
        moduleSpecifier: spec,
        namedImports: values.map((v) => ({ name: v.name, alias: v.alias })),
      });
    if (types.length)
      structures.push({
        moduleSpecifier: spec,
        isTypeOnly: true,
        namedImports: types.map((t) => ({ name: t.name, alias: t.alias })),
      });
  }
  return structures;
}

function renderNamedExport(spec, specs, allType) {
  const body = specs
    .map((s) => `${allType ? '' : s.isTypeOnly ? 'type ' : ''}${s.name}${s.alias ? ' as ' + s.alias : ''}`)
    .join(', ');
  return `${allType ? 'export type' : 'export'} { ${body} } from '${spec}';`;
}

function exportClauseToText(c) {
  if (c.kind === 'star') return `export * from '${relSpec(c.file)}';`;
  if (c.kind === 'namespace') return `export * as ${c.name} from '${relSpec(c.file)}';`;
  return renderNamedExport(relSpec(c.file), c.specs, c.isTypeOnly);
}

// ---------------------------------------------------------------------------
// Entry (src/index.ts) regeneration.
// ---------------------------------------------------------------------------
function regenerateEntry() {
  const entrySf = project.getSourceFileOrThrow(ENTRY);
  const original = entrySf.getFullText();
  const headerMatch = original.match(/^\s*\/\*\*[\s\S]*?\*\//);
  const header = headerMatch ? headerMatch[0] : '/** agent-core-v2 public surface. */';

  // First pass: classify each referenced barrel and how it is referenced.
  /** @type {Array<{decl: any, barrel: any, mode: 'star'|'named'|'side'}>} */
  const refs = [];
  for (const decl of [...entrySf.getExportDeclarations(), ...entrySf.getImportDeclarations()]) {
    const barrel = barrelOfDecl(decl);
    if (!barrel) continue;
    let mode;
    if (decl.getKindName() === 'ImportDeclaration') mode = 'side';
    else {
      const isStar = decl.getNamedExports().length === 0 && !decl.getNamespaceExport();
      mode = isStar ? 'star' : 'named';
    }
    refs.push({ decl, barrel, mode });
  }

  const publicLines = [];
  const loadingLines = [];
  const processed = new Set();

  for (const { decl, barrel, mode } of refs) {
    const bf = barrel.getFilePath();
    const dirAbs = path.dirname(bf);
    const allLeaves = allLeavesUnderDir(dirAbs);
    const clauses = expandBarrelClauses(barrel);
    const starLeaves = new Set(clauses.filter((c) => c.kind === 'star').map((c) => c.file));

    if (mode === 'star') {
      // Public: replay the barrel's clauses in order against precise leaves.
      for (const c of clauses) publicLines.push(exportClauseToText(c));
    } else if (mode === 'named') {
      const declType = decl.isTypeOnly();
      const groups = new Map();
      for (const s of decl.getNamedExports()) {
        const lookup = s.getName();
        const exportedAs = s.getAliasNode()?.getText() || s.getName();
        const r = resolveName(barrel, lookup);
        if (!r) continue;
        if (!groups.has(r.leafFile)) groups.set(r.leafFile, { specs: [], allType: true });
        const g = groups.get(r.leafFile);
        const t = declType || s.isTypeOnly();
        g.allType = g.allType && t;
        g.specs.push({
          name: r.leafName,
          alias: exportedAs !== r.leafName ? exportedAs : undefined,
          isTypeOnly: t,
        });
      }
      for (const [leaf, { specs, allType }] of groups) {
        publicLines.push(renderNamedExport(relSpec(leaf), specs, allType));
      }
    }
    // Loading: any leaf of this domain not already pulled in by an `export *`
    // line must be imported for its side effects (registers).
    for (const leaf of allLeaves) {
      const key = leaf;
      if (starLeaves.has(leaf)) continue; // loaded by export *
      if (processed.has(key)) continue;
      processed.add(key);
      loadingLines.push(`import '${relSpec(leaf)}';`);
    }
  }

  const body = [
    header,
    '',
    '// Public surface — precise re-exports of each domain leaf (no barrels).',
    ...publicLines,
    '',
    '// Side-effect loading — ensure every domain leaf (and its top-level',
    '// `register*` calls) is evaluated when the package is imported.',
    ...loadingLines,
    '',
  ].join('\n');

  if (!DRY) fs.writeFileSync(ENTRY, body);
  return { publicLines: publicLines.length, loadingLines: loadingLines.length };
}

// ---------------------------------------------------------------------------
// Register-file enumeration + coverage verification.
// ---------------------------------------------------------------------------
const REGISTER_NAMES = new Set([
  'registerScopedService',
  'registerTool',
  'registerErrorDomain',
  'registerConfigSection',
  'registerAgentProfile',
  'registerFlagDefinition',
]);

function isModuleScoped(call) {
  let n = call.getParent();
  while (n) {
    const k = n.getKindName();
    if (
      k === 'FunctionDeclaration' ||
      k === 'FunctionExpression' ||
      k === 'ArrowFunction' ||
      k === 'MethodDeclaration' ||
      k === 'Constructor' ||
      k === 'ClassDeclaration'
    ) {
      return false;
    }
    n = n.getParent();
  }
  return true;
}

function findRegisterFiles() {
  const files = [];
  for (const sf of project.getSourceFiles()) {
    const f = sf.getFilePath();
    if (!isUnderSrc(f) || f.endsWith('.test.ts')) continue;
    let hit = false;
    sf.forEachDescendant((node) => {
      if (hit) return;
      if (node.getKindName() !== 'CallExpression') return;
      const expr = node.getExpression();
      if (expr.getKindName() !== 'Identifier') return;
      if (!REGISTER_NAMES.has(expr.getText())) return;
      if (isModuleScoped(node)) hit = true;
    });
    if (hit) files.push(f);
  }
  return files.sort();
}

function reachedFromEntry() {
  const reached = new Set();
  const visit = (sf) => {
    const f = sf.getFilePath();
    if (reached.has(f)) return;
    reached.add(f);
    if (!isUnderSrc(f)) return;
    const edges = [...sf.getImportDeclarations(), ...sf.getExportDeclarations()];
    for (const d of edges) {
      if (d.isTypeOnly && d.isTypeOnly()) continue; // type-only edges don't execute
      const t = resolvedFile(d);
      if (t && isUnderSrc(t.getFilePath())) visit(t);
    }
  };
  visit(project.getSourceFileOrThrow(ENTRY));
  return reached;
}

function verifyCoverage() {
  const regs = findRegisterFiles();
  const reached = reachedFromEntry();
  const missing = regs.filter((f) => !reached.has(f));
  console.log(`register files: ${regs.length}; reachable from entry: ${reached.size}; missing: ${missing.length}`);
  if (missing.length) {
    console.log('MISSING (not reachable from src/index.ts):');
    for (const m of missing) console.log('  ' + path.relative(PKG, m));
    return false;
  }
  return true;
}

function deleteBarrels() {
  let n = 0;
  for (const sf of project.getSourceFiles()) {
    if (!isBarrelFile(sf)) continue;
    const f = sf.getFilePath();
    if (!DRY) fs.unlinkSync(f);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Main dispatch.
// ---------------------------------------------------------------------------
function main() {
  if (LIST_REGS) {
    for (const f of findRegisterFiles()) console.log(path.relative(PKG, f));
    return;
  }
  if (VERIFY) {
    const ok = verifyCoverage();
    process.exit(ok ? 0 : 1);
  }
  if (ENTRY_ONLY) {
    const r = regenerateEntry();
    console.log(`entry regenerated: ${r.publicLines} public lines, ${r.loadingLines} loading lines${DRY ? ' (dry-run)' : ''}`);
    return;
  }

  let onlyBarrelPath = null;
  if (ONLY) {
    onlyBarrelPath = path.join(SRC, ONLY, 'index.ts');
    if (!fs.existsSync(onlyBarrelPath)) {
      console.error(`--only target not a barrel: ${path.relative(PKG, onlyBarrelPath)}`);
      process.exit(2);
    }
  }

  const totals = { files: 0, imports: 0, exports: 0, sideEffects: 0, manuals: [] };
  for (const sf of project.getSourceFiles()) {
    const f = sf.getFilePath();
    if (!isUnderSrc(f) && !f.startsWith(path.join(PKG, 'test') + path.sep)) continue;
    if (f === ENTRY) continue; // entry handled by --entry
    const before = sf.getFullText();
    const r = rewriteConsumerFile(sf, onlyBarrelPath);
    if (sf.getFullText() !== before) {
      totals.files++;
      totals.imports += r.imports;
      totals.exports += r.exports;
      totals.sideEffects += r.sideEffects;
    }
    totals.manuals.push(...r.manuals);
  }

  if (!DRY) project.saveSync();

  console.log(
    `rewrote ${totals.files} files: ${totals.imports} barrel imports, ${totals.exports} barrel exports, ${totals.sideEffects} side-effect loads${DRY ? ' (dry-run)' : ''}`,
  );
  if (totals.manuals.length) {
    console.log(`MANUAL (${totals.manuals.length}) — could not auto-split:`);
    for (const m of totals.manuals)
      console.log(`  ${path.relative(PKG, m.sf)} :: ${m.why} :: ${m.text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  if (DELETE_BARRELS) {
    const n = deleteBarrels();
    console.log(`deleted ${n} domain barrels${DRY ? ' (dry-run)' : ''}`);
  }
}

main();
