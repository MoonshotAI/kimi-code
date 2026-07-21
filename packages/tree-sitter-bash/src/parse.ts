// src/parse.ts
//
// Public parse entry point. Runs the hand-written lexer + recursive-descent
// parser under a ParseBudget and returns the materialized syntax tree.
//
// Exit contract:
//   - Budget exhaustion (time or node cap) → { ok: false, reason: 'aborted' }.
//     `Aborted` never escapes.
//   - Malformed input → { ok: true, hasError: true } with ERROR nodes and/or
//     partial nodes where the parser recovered.
//   - Any other parser-internal exception (a bug, not user input) is caught
//     here as a last resort: the caller still gets a usable tree — a program
//     root with a single ERROR child spanning the whole source and
//     hasError: true — instead of an exception. Chosen over reporting
//     'aborted' because the parse did not hit its budget; downstream
//     consumers keep working on a degraded tree and hasError signals the
//     failure. (See the catch block below.)

import { Aborted, ParseBudget } from '#/budget';
import type { BudgetOptions } from '#/budget';
import { SyntaxNodeBuilder } from '#/node';
import type { SyntaxNode } from '#/node';
import { Parser, materialize } from '#/parser';

export type ParseResult =
  | { ok: true; rootNode: SyntaxNode; hasError: boolean }
  | { ok: false; reason: 'aborted' };

export type ParseOptions = BudgetOptions;

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const budget = new ParseBudget(options);
  try {
    const parser = new Parser(source, budget);
    const root = parser.parseProgram();
    const rootNode = materialize(root, source);
    return { ok: true, rootNode, hasError: parser.hasError };
  } catch (error) {
    if (error instanceof Aborted) return { ok: false, reason: 'aborted' };
    // Last-resort guard for parser bugs: degrade to an ERROR root instead of
    // throwing into the caller (see the file header for why).
    const root = new SyntaxNodeBuilder({ type: 'program', source, startIndex: 0, endIndex: source.length });
    root.addChild(new SyntaxNodeBuilder({ type: 'ERROR', source, startIndex: 0, endIndex: source.length }));
    return { ok: true, rootNode: root, hasError: true };
  }
}
