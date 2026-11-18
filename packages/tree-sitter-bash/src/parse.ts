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
    const root = new SyntaxNodeBuilder({ type: 'program', source, startIndex: 0, endIndex: source.length });
    root.addChild(new SyntaxNodeBuilder({ type: 'ERROR', source, startIndex: 0, endIndex: source.length }));
    return { ok: true, rootNode: root, hasError: true };
  }
}
