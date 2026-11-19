import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';
import { parseSync } from 'oxc-parser';

const ALLOWLIST_FILE = '.commentignore';
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const JS_FILE = /\.[cm]?jsx?$/;
const JSDOC_TYPE = /^\*\s*@(?:type|satisfies)\s*\{[^\n]*\}\s*$/;
const DIRECTIVES = [
  /^@ts-(?:expect-error|ignore|nocheck|check)\b/,
  /^(?:oxlint|eslint)-(?:disable|enable)\b/,
  /^(?:prettier|oxfmt)-ignore\b/,
  /^\/\s*<reference\b/,
  /^[@#]__(?:PURE|NO_SIDE_EFFECTS)__\s*$/,
  /^@vite-ignore\s*$/,
  /^(?:istanbul|c8|v8) ignore\b/,
  /^@vitest-environment\b/,
  /^@jsx(?:ImportSource|Frag|Runtime)?\b/,
];
const CLOSERS = { '{': '}', '(': ')', '[': ']' };
const TOKEN_CHAR = /[\w$+\-*/%<>=!&|^~?.]/;
const GUIDANCE = [
  'Comments are not allowed in JS/TS code. Delete them: let names, types, and structure say what the code does,',
  'and turn a stated constraint into a type, a test, or a lint rule instead of a note.',
  '`node scripts/check-comments.mjs --fix` deletes every reported comment.',
].join('\n');

function isExempt(file, source, comment) {
  if (comment.start === 0 && source.startsWith('#!')) return true;
  if (JS_FILE.test(file) && comment.type === 'Block' && JSDOC_TYPE.test(comment.value)) return true;
  const body = comment.value.replace(/^[\s*]+/, '');
  return DIRECTIVES.some((directive) => directive.test(body));
}

export function findComments(file, source) {
  const { comments, errors } = parseSync(file, source);
  return { errors, comments: comments.filter((comment) => !isExempt(file, source, comment)) };
}

export function stripComments(file, source, comments) {
  const before = parseSync(file, source);
  const containers = emptyJsxContainers(before.program);
  const ranges = mergeRanges(
    comments.map(
      (comment) =>
        containers.find(({ start, end }) => start <= comment.start && comment.end <= end) ?? {
          start: comment.start,
          end: comment.end,
          exact: false,
        },
    ),
  );
  let text = source;
  for (const range of ranges.toReversed()) text = removeRange(text, range);
  text = tidyEnd(text, source);
  const after = parseSync(file, text);
  if (after.errors.length > 0 || canonical(before.program) !== canonical(after.program)) return undefined;
  return text;
}

function emptyJsxContainers(program) {
  const containers = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'JSXExpressionContainer' && node.expression.type === 'JSXEmptyExpression') {
      containers.push({ start: node.start, end: node.end, exact: true });
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return containers;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function removeRange(text, { start, end, exact }) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  const head = text.slice(0, start);
  const tail = text.slice(end);
  const blankBefore = isBlank(text.slice(lineStart, start));
  const blankAfter = isBlank(text.slice(end, lineEnd));
  if (blankBefore && blankAfter) return removeLines(text, lineStart, newline === -1 ? text.length : newline + 1);
  if (exact) return head + tail;
  if (blankAfter) return head.replace(/[ \t]+$/, '') + text.slice(lineEnd);
  if (blankBefore) return head + tail.replace(/^[ \t]+/, '');
  if (text.slice(start, end).includes('\n')) return `${head}\n${tail}`;
  const trimmedHead = head.replace(/[ \t]+$/, '');
  const trimmedTail = tail.replace(/^[ \t]+/, '');
  const opener = trimmedHead.at(-1);
  if (opener !== undefined && Object.hasOwn(CLOSERS, opener) && trimmedTail.startsWith(CLOSERS[opener])) {
    return trimmedHead + trimmedTail;
  }
  if (/^[ \t]/.test(tail)) return head + tail.replace(/^[ \t]+/, '');
  if (/[ \t]$/.test(head)) return head.replace(/[ \t]+$/, '') + tail;
  return head + (TOKEN_CHAR.test(head.at(-1) ?? '') && TOKEN_CHAR.test(tail[0] ?? '') ? ' ' : '') + tail;
}

function removeLines(text, from, to) {
  const head = text.slice(0, from);
  const tail = text.slice(to);
  const previousStart = text.lastIndexOf('\n', from - 2) + 1;
  const previous = from === 0 ? '' : text.slice(previousStart, from - 1);
  if (from === 0 || (previousStart === 0 && previous.startsWith('#!'))) {
    return head + tail.replace(/^(?:[ \t]*\r?\n)+/, '');
  }
  const nextEnd = tail.indexOf('\n');
  const next = nextEnd === -1 ? tail : tail.slice(0, nextEnd);
  const opener = previous.trimEnd().at(-1);
  const opens = opener !== undefined && opener in CLOSERS;
  if (opens && next.trimStart().startsWith(CLOSERS[opener])) {
    return head.slice(0, from - 1).replace(/[ \t\r]+$/, '') + tail.replace(/^[ \t]+/, '');
  }
  if ((isBlank(previous) || opens) && isBlank(next) && nextEnd !== -1) return head + tail.slice(nextEnd + 1);
  if (isBlank(previous) && /^[ \t]*[})\]]/.test(next)) return text.slice(0, previousStart) + tail;
  return head + tail;
}

function tidyEnd(text, original) {
  if (original.endsWith('\n\n') || !text.endsWith('\n\n')) return text;
  return `${text.replace(/\s+$/, '')}\n`;
}

function isBlank(text) {
  return /^\s*$/.test(text);
}

function canonical(program) {
  return JSON.stringify(program, (key, value) => {
    if (key === 'start' || key === 'end') return undefined;
    if (key === 'children' && Array.isArray(value)) return jsxChildren(value);
    return value;
  });
}

function jsxChildren(children) {
  return children
    .filter((child) => child.type !== 'JSXExpressionContainer' || child.expression.type !== 'JSXEmptyExpression')
    .map((child) => (child.type === 'JSXText' ? { type: 'JSXText', value: cleanJsxText(child.value) } : child))
    .filter((child) => child.type !== 'JSXText' || child.value !== '');
}

function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  const lastContent = lines.findLastIndex((line) => /[^ \t]/.test(line));
  return lines
    .map((line, index) => {
      let text = line.replaceAll('\t', ' ');
      if (index > 0) text = text.replace(/^ +/, '');
      if (index < lines.length - 1) text = text.replace(/ +$/, '');
      return text !== '' && index !== lastContent ? `${text} ` : text;
    })
    .join('');
}

function listSourceFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter((file) => SOURCE_FILE.test(file) && existsSync(path.join(root, file)));
}

function readAllowlist(root) {
  const file = path.join(root, ALLOWLIST_FILE);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const entries = lines
    .map((line, index) => ({ pattern: line.trim(), line: index + 1 }))
    .filter(({ pattern }) => pattern !== '' && !pattern.startsWith('#') && !pattern.startsWith('!'));
  return { matcher: ignore().add(lines), entries };
}

function lineStarts(source) {
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function position(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return `${low + 1}:${offset - starts[low] + 1}`;
}

function preview(comment) {
  const text = (comment.type === 'Line' ? `//${comment.value}` : `/*${comment.value}*/`).replaceAll(/\s+/g, ' ');
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function main(argv) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const fix = argv.includes('--fix');
  const targets = argv
    .filter((arg) => arg !== '--fix')
    .map((arg) => path.relative(root, path.resolve(arg)))
    .filter((file) => file !== '' && !file.startsWith('..') && !path.isAbsolute(file));
  const full = targets.length === 0 || targets.includes(ALLOWLIST_FILE);
  const files = full
    ? listSourceFiles(root)
    : targets.filter((file) => SOURCE_FILE.test(file) && existsSync(path.join(root, file)));
  const allowlist = readAllowlist(root);
  const commentedAllowed = [];
  const problems = [];
  let removed = 0;
  for (const file of files) {
    const allowed = allowlist.matcher.ignores(file);
    if (allowed && !full) continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    const { errors, comments } = findComments(file, source);
    if (allowed) {
      if (comments.length > 0) commentedAllowed.push(file);
      continue;
    }
    if (errors.length > 0) {
      problems.push(`${file}: cannot be parsed, so its comments cannot be checked: ${errors[0].message}`);
      continue;
    }
    if (comments.length === 0) continue;
    if (fix) {
      const fixed = stripComments(file, source, comments);
      if (fixed !== undefined) {
        writeFileSync(path.join(root, file), fixed);
        removed += comments.length;
        continue;
      }
      problems.push(`${file}: removing these comments would change the code, so delete them by hand`);
    }
    const starts = lineStarts(source);
    for (const comment of comments) problems.push(`${file}:${position(starts, comment.start)}: ${preview(comment)}`);
  }
  const commentProblems = problems.length;
  if (full) {
    for (const { pattern, line } of allowlist.entries) {
      const matcher = ignore().add(pattern);
      if (!commentedAllowed.some((file) => matcher.ignores(file))) {
        problems.push(`${ALLOWLIST_FILE}:${line}: "${pattern}" matches no file with comments; delete this entry`);
      }
    }
  }
  if (removed > 0) process.stdout.write(`check-comments: removed ${removed} comment(s)\n`);
  if (problems.length === 0) {
    process.stdout.write(`check-comments: OK (${files.length} files)\n`);
    return 0;
  }
  process.stderr.write(`${problems.join('\n')}\n`);
  if (commentProblems > 0) process.stderr.write(`\n${GUIDANCE}\n`);
  return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
