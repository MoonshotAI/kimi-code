// test/helpers/differential.ts
//
// Differential test harness: parses the same source with both this package's
// parser and the real tree-sitter-bash (web-tree-sitter + the official wasm
// build shipped in the tree-sitter-bash npm package), normalizes both trees
// into a comparable dump, and produces structured diffs.
//
// Normalization: a pre-order dump of EVERY node (named and anonymous — the
// byte-identical trees M1/M2 verified include the anonymous token layer),
// one line per node: `<indent>type [start,end] "text preview"`, anonymous
// types wrapped in parens, plus a leading `hasError:` line. Both sides use
// UTF-16 code unit offsets directly: web-tree-sitter (wasm) reports UTF-16
// offsets for string input, same as this parser (verified: for
// "echo 你好 && ls" the reference reports the root as [0,13] and `&&` as
// [8,10] — UTF-16 code units, not UTF-8 bytes).

import path from 'node:path';

import { Language, Parser as RefParser } from 'web-tree-sitter';
import type { Node as RefNode } from 'web-tree-sitter';

import type { SyntaxNode } from '#/node';
import { parse } from '#/parse';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');
const WASM_PATH = path.join(PACKAGE_ROOT, 'node_modules/tree-sitter-bash/tree-sitter-bash.wasm');

let refParserPromise: Promise<RefParser> | null = null;

/**
 * Lazily load web-tree-sitter + the bash wasm exactly once per test process.
 * Load failures throw a descriptive error (never silently skip): the
 * differential suite is meaningless without the reference.
 */
export function loadReferenceParser(): Promise<RefParser> {
  refParserPromise ??= (async () => {
    try {
      await RefParser.init();
      const language = await Language.load(WASM_PATH);
      const parser = new RefParser();
      parser.setLanguage(language);
      return parser;
    } catch (error) {
      throw new Error(
        `failed to load the tree-sitter-bash wasm reference (expected at ${WASM_PATH}). ` +
          'Run `pnpm install` and make sure the tree-sitter-bash devDependency is present.',
        { cause: error },
      );
    }
  })();
  return refParserPromise;
}

interface DumpLine {
  depth: number;
  label: string;
  start: number;
  end: number;
  text: string;
}

function render(lines: DumpLine[], hasError: boolean): string {
  const out = [`hasError: ${hasError}`];
  for (const line of lines) {
    const preview =
      line.text.length <= 40 ? JSON.stringify(line.text) : JSON.stringify(`${line.text.slice(0, 37)}...`);
    out.push(`${'  '.repeat(line.depth)}${line.label} [${line.start},${line.end}] ${preview}`);
  }
  return out.join('\n');
}

function label(type: string, isNamed: boolean): string {
  return isNamed ? type : `(${type})`;
}

/** Normalized dump of the reference tree (UTF-16 offsets as reported). */
export async function referenceDump(source: string): Promise<string> {
  const parser = await loadReferenceParser();
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`reference parser returned null for ${JSON.stringify(source)}`);
  const lines: DumpLine[] = [];
  const stack: Array<{ node: RefNode; depth: number }> = [{ node: tree.rootNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    lines.push({
      depth,
      label: label(node.type, node.isNamed),
      start: node.startIndex,
      end: node.endIndex,
      text: source.slice(node.startIndex, node.endIndex),
    });
    for (let i = node.childCount - 1; i >= 0; i--) stack.push({ node: node.child(i)!, depth: depth + 1 });
  }
  return render(lines, tree.rootNode.hasError);
}

/**
 * Normalized dump of our tree. Parses with a generous budget so differential
 * results are never polluted by the default 50 ms / 50 000-node budget;
 * fixtures are expected to parse, so an abort here is an error.
 */
export function ourDump(source: string): string {
  const result = parse(source, { timeoutMs: 60_000, maxNodes: 10_000_000 });
  if (!result.ok) throw new Error(`our parser aborted on a differential fixture: ${JSON.stringify(source)}`);
  const lines: DumpLine[] = [];
  const stack: Array<{ node: SyntaxNode; depth: number }> = [{ node: result.rootNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    lines.push({ depth, label: label(node.type, node.isNamed), start: node.startIndex, end: node.endIndex, text: node.text });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, depth: depth + 1 });
  }
  return render(lines, result.hasError);
}

/** First-difference report between two dumps; empty string when identical. */
export function diffDumps(ours: string, reference: string): string {
  if (ours === reference) return '';
  const a = ours.split('\n');
  const b = reference.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const slice = (lines: string[], from: number): string =>
    lines
      .slice(from, from + 8)
      .map((line, j) => `${from + j === i ? '>' : ' '} ${line}`)
      .join('\n');
  const at = Math.max(0, i - 2);
  return (
    `trees differ at dump line ${i + 1}:\n` +
    `  ours:\n${slice(a, at)}\n` +
    `  reference:\n${slice(b, at)}`
  );
}

export interface Comparison {
  equal: boolean;
  ours: string;
  reference: string;
  diff: string;
}

/** Parse `source` with both parsers and compare the normalized dumps. */
export async function compareSource(source: string): Promise<Comparison> {
  const [ours, reference] = [ourDump(source), await referenceDump(source)];
  return { equal: ours === reference, ours, reference, diff: diffDumps(ours, reference) };
}

/**
 * Tree integrity self-check (used by fuzz): every node range must lie inside
 * the source, `text` must equal the corresponding slice, and children must be
 * contained in their parent, in source order, without overlaps. Throws with a
 * descriptive message on the first violation.
 */
export function assertTreeIntegrity(root: SyntaxNode, source: string): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.startIndex < 0 || node.endIndex < node.startIndex || node.endIndex > source.length) {
      throw new Error(`node ${node.type} range [${node.startIndex}, ${node.endIndex}) escapes source length ${source.length}`);
    }
    if (node.text !== source.slice(node.startIndex, node.endIndex)) {
      throw new Error(`node ${node.type} text does not match source.slice(${node.startIndex}, ${node.endIndex})`);
    }
    let previousEnd = node.startIndex;
    for (const child of node.children) {
      if (child.startIndex < node.startIndex || child.endIndex > node.endIndex) {
        throw new Error(`child ${child.type} escapes parent ${node.type}`);
      }
      if (child.startIndex < previousEnd) {
        throw new Error(`child ${child.type} overlaps its previous sibling in ${node.type}`);
      }
      previousEnd = child.endIndex;
      stack.push(child);
    }
  }
}

// ------------------------------------------------------------- fixture I/O

/** A curated differential fixture sample (see test/fixtures/differential/). */
export interface FixtureSample {
  /** Directive: 'match' (must equal the reference) or 'known-diff'. */
  kind: 'match' | 'known-diff';
  /** Known-difference registry id (known-diff samples only). */
  id?: string;
  /** Free-form description from the directive line. */
  description: string;
  source: string;
  /** Stored expected dump of OUR parser (known-diff samples only). */
  expectedOurs?: string;
  /** 1-based line of the directive, for error messages. */
  line: number;
}

const DIRECTIVE_RE = /^@(match|known-diff)(?:\s+(\S+))?:\s*(.*)$/;
const SEPARATOR_RE = /^===\s*$/m;
const DUMP_SPLIT_RE = /^---\s*$/m;

/** One official tree-sitter-bash corpus test case (input only — the
 *  expected S-expression is ignored; the live wasm reference is the
 *  comparison target). */
export interface CorpusCase {
  name: string;
  input: string;
}

/** Parse an official corpus file (`==== name ====` / input / `----` /
 *  expected). The separator is any run of 3+ dashes. */
export function parseCorpusFile(content: string): CorpusCase[] {
  const out: CorpusCase[] = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!/^=+\s*$/.test(lines[i]!)) {
      i++;
      continue;
    }
    i++;
    const nameLines: string[] = [];
    while (i < lines.length && !/^=+\s*$/.test(lines[i]!)) nameLines.push(lines[i++]!);
    i++;
    const inputLines: string[] = [];
    while (i < lines.length && !/^-{3,}\s*$/.test(lines[i]!)) inputLines.push(lines[i++]!);
    i++;
    while (i < lines.length && !/^=+\s*$/.test(lines[i]!)) i++;
    out.push({ name: nameLines.join(' ').trim(), input: inputLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '') });
  }
  return out;
}


/**
 * Parse a fixture file. Format: blocks separated by lines of `===`; each
 * block starts with `@match: <desc>` or `@known-diff <registry-id>: <desc>`,
 * followed by the sample source. known-diff blocks additionally carry the
 * expected dump of our parser after a `---` line (the disclosed deviation
 * shape — if our output drifts from it, or starts matching the reference,
 * the test fails).
 */
export function parseFixtureFile(filePath: string, content: string): FixtureSample[] {
  const samples: FixtureSample[] = [];
  const blocks = content.split(SEPARATOR_RE);
  let line = 1;
  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\n/, '').replace(/\n$/, '');
    const blockLine = line;
    line += rawBlock.split('\n').length;
    if (block.trim().length === 0) continue;
    const nl = block.indexOf('\n');
    const directiveLine = nl === -1 ? block : block.slice(0, nl);
    const body = nl === -1 ? '' : block.slice(nl + 1);
    const directive = DIRECTIVE_RE.exec(directiveLine.trim());
    if (directive === null) {
      throw new Error(`${filePath}:${blockLine}: expected a @match: / @known-diff <id>: directive, got ${JSON.stringify(directiveLine)}`);
    }
    const [, kind, id, description = ''] = directive;
    if (kind === 'match') {
      samples.push({ kind, description, source: body, line: blockLine });
    } else {
      if (id === undefined) throw new Error(`${filePath}:${blockLine}: @known-diff requires a registry id`);
      const parts = body.split(DUMP_SPLIT_RE);
      if (parts.length !== 2) {
        throw new Error(`${filePath}:${blockLine}: @known-diff block must contain a --- line followed by the expected dump of our parser`);
      }
      const source = parts[0]!.replace(/\n$/, '');
      const expectedOurs = parts[1]!.replace(/^\n/, '').replace(/\n$/, '');
      samples.push({ kind: 'known-diff', id, description, source, expectedOurs, line: blockLine });
    }
  }
  return samples;
}
