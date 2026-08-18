import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['packages/agent-core-v2', 'packages/kap-server', 'packages/transcript'];
const DIRS = ['src', 'test', 'scripts'];

const MEMBER_KINDS = new Set([
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.IndexSignature,
]);

const DECL_KINDS = new Set([
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ModuleDeclaration,
]);

function hasExportModifier(node) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isFunctionWithBody(node) {
  return (ts.isFunctionLike(node) || ts.isArrowFunction(node)) && node.body !== undefined;
}

function collectBinding(name, out) {
  if (ts.isIdentifier(name)) out.add(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (ts.isBindingElement(el)) collectBinding(el.name, out);
  }
}

function declaredNames(node, out) {
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) collectBinding(d.name, out);
  } else if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name
  ) {
    out.add(node.name.text);
  }
}

function computeKeptJSDocStarts(sf) {
  const exportedNames = new Set();
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        exportedNames.add((el.propertyName ?? el.name).text);
      }
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      exportedNames.add(stmt.expression.text);
    }
  }

  const kept = new Set();

  function visit(node, ctx) {
    const exported = hasExportModifier(node);
    let effectivelyExported = exported;
    if (!effectivelyExported && node.parent && ts.isSourceFile(node.parent)) {
      const names = new Set();
      declaredNames(node, names);
      for (const n of names) {
        if (exportedNames.has(n)) {
          effectivelyExported = true;
          break;
        }
      }
    }

    if (effectivelyExported || (ctx && (MEMBER_KINDS.has(node.kind) || DECL_KINDS.has(node.kind)))) {
      const docs = node.jsDoc;
      if (Array.isArray(docs)) for (const d of docs) kept.add(d.getStart(sf));
    }

    let childCtx;
    if (isFunctionWithBody(node)) childCtx = false;
    else if (effectivelyExported) childCtx = true;
    else childCtx = ctx;

    node.forEachChild((c) => visit(c, childCtx));
  }

  visit(sf, false);
  return kept;
}

function collectLeaves(node, leaves, jsdocNodes) {
  if (ts.isJSDoc(node)) {
    jsdocNodes.push(node);
    return;
  }
  const children = node.getChildren();
  if (children.length === 0) {
    if (node.getWidth() > 0) leaves.push(node);
    return;
  }
  for (const c of children) collectLeaves(c, leaves, jsdocNodes);
}

function extractGapComments(gap, offset, out) {
  let i = 0;
  while (i < gap.length) {
    const ch = gap[i];
    if (' \t\n\r\f\v'.includes(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '/') {
      let j = gap.indexOf('\n', i);
      if (j === -1) j = gap.length;
      out.push({ pos: offset + i, end: offset + j, jsdoc: false });
      i = j;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '*') {
      const close = gap.indexOf('*/', i + 2);
      const j = close === -1 ? gap.length : close + 2;
      out.push({ pos: offset + i, end: offset + j, jsdoc: gap.startsWith('/**', i) });
      i = j;
      continue;
    }
    break;
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const keptStarts = computeKeptJSDocStarts(sf);

  const leaves = [];
  const jsdocNodes = [];
  collectLeaves(sf, leaves, jsdocNodes);
  leaves.sort((a, b) => a.getStart(sf) - b.getStart(sf));

  const comments = [];
  let cursor = 0;
  for (const leaf of leaves) {
    const s = leaf.getStart(sf);
    if (s > cursor) extractGapComments(text.slice(cursor, s), cursor, comments);
    cursor = Math.max(cursor, leaf.getEnd());
  }
  if (cursor < text.length) extractGapComments(text.slice(cursor), cursor, comments);
  for (const d of jsdocNodes) {
    comments.push({ pos: d.getStart(sf), end: d.getEnd(), jsdoc: true });
  }

  const seen = new Set();
  const violations = [];
  for (const c of comments) {
    const key = `${c.pos}:${c.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.jsdoc && keptStarts.has(c.pos)) continue;
    const line = text.slice(0, c.pos).split('\n').length;
    const snippet = text.slice(c.pos, Math.min(c.end, c.pos + 60)).replace(/\s+/g, ' ');
    if (/(?:oxlint|eslint)-disable/.test(snippet)) continue;
    const isDirective = /@ts-(expect-error|ignore|nocheck)|prettier-ignore|istanbul|c8 ignore/.test(
      snippet,
    );
    violations.push({ line, snippet, isDirective });
  }
  return violations;
}

const files = [];
for (const pkg of PACKAGES) {
  for (const dir of DIRS) {
    const root = path.join(ROOT, pkg, dir);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') stack.push(p);
        } else if (/\.(ts|tsx|mts)$/.test(e.name)) {
          files.push(p);
        }
      }
    }
  }
}

let total = 0;
for (const f of files) {
  const violations = checkFile(f);
  for (const v of violations) {
    total++;
    const rel = path.relative(ROOT, f);
    if (v.isDirective) {
      console.error(`${rel}:${v.line}: tooling directives are not allowed — fix the underlying lint/type problem instead: ${v.snippet}`);
    } else if (v.snippet.startsWith('/**')) {
      console.error(`${rel}:${v.line}: JSDoc is only allowed on exported symbols: ${v.snippet}`);
    } else {
      console.error(`${rel}:${v.line}: comments are not allowed in this package: ${v.snippet}`);
    }
  }
}

if (total > 0) {
  console.error(`check-no-comments: ${total} violation(s) in ${PACKAGES.join(', ')}`);
  process.exit(1);
}
console.log(`check-no-comments: OK (${files.length} files)`);
