// src/parse.ts
//
// Public parse entry point. M0 ships a placeholder parser: the whole source is
// wrapped in a `program` root with a single `word` child covering the entire
// text. The budget mechanism is real, and later milestones keep this exact
// entry/exit contract while replacing the placeholder with the actual
// lexer + parser.

import { Aborted, ParseBudget } from '#/budget';
import type { BudgetOptions } from '#/budget';
import { SyntaxNodeBuilder } from '#/node';
import type { SyntaxNode } from '#/node';

export type ParseResult =
  | { ok: true; rootNode: SyntaxNode; hasError: boolean }
  | { ok: false; reason: 'aborted' };

export type ParseOptions = BudgetOptions;

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const budget = new ParseBudget(options);
  try {
    const root = new SyntaxNodeBuilder({ type: 'program', source, startIndex: 0, endIndex: source.length });
    budget.tick();
    if (source.length > 0) {
      root.addChild(new SyntaxNodeBuilder({ type: 'word', source, startIndex: 0, endIndex: source.length }));
      budget.tick();
    }
    return { ok: true, rootNode: root, hasError: false };
  } catch (error) {
    if (error instanceof Aborted) return { ok: false, reason: 'aborted' };
    throw error;
  }
}
