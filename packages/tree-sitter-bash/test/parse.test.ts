import { describe, expect, it } from 'vitest';

import { Aborted, ParseBudget } from '#/budget';
import { parse } from '#/parse';

describe('ParseBudget', () => {
  it('counts nodes and stays under the cap', () => {
    const budget = new ParseBudget({ timeoutMs: 60_000, maxNodes: 3 });
    budget.tick();
    budget.tick();
    expect(budget.nodesUsed).toBe(2);
  });

  it('throws Aborted when the node cap is exceeded', () => {
    const budget = new ParseBudget({ timeoutMs: 60_000, maxNodes: 1 });
    budget.tick();
    expect(() => budget.tick()).toThrow(Aborted);
  });

  it('throws Aborted once the deadline is reached', () => {
    const budget = new ParseBudget({ timeoutMs: 0, maxNodes: 1_000 });
    expect(() => budget.tick()).toThrow(Aborted);
  });

  it('applies documented defaults', () => {
    const budget = new ParseBudget();
    // Default node cap is 50_000: the 50_000th node is still allowed.
    for (let i = 0; i < 50_000; i++) budget.tick();
    expect(() => budget.tick()).toThrow(Aborted);
  });
});

describe('parse (M0 placeholder)', () => {
  it('wraps the whole source in a program root with a single word child', () => {
    const source = 'echo hello';
    const result = parse(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasError).toBe(false);
    expect(result.rootNode.type).toBe('program');
    expect(result.rootNode.text).toBe(source);
    expect(result.rootNode.startIndex).toBe(0);
    expect(result.rootNode.endIndex).toBe(source.length);
    expect(result.rootNode.namedChildren).toHaveLength(1);
    const word = result.rootNode.namedChildren[0]!;
    expect(word.type).toBe('word');
    expect(word.text).toBe(source);
    expect(word.parent).toBe(result.rootNode);
  });

  it('parses an empty source into an empty program', () => {
    const result = parse('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rootNode.type).toBe('program');
    expect(result.rootNode.text).toBe('');
    expect(result.rootNode.children).toHaveLength(0);
  });

  it('returns { ok: false, reason: "aborted" } when the node budget is exceeded', () => {
    // The placeholder parse creates 2 nodes (program + word).
    expect(parse('echo hello', { timeoutMs: 60_000, maxNodes: 1 })).toEqual({ ok: false, reason: 'aborted' });
  });

  it('returns { ok: false, reason: "aborted" } when the deadline has passed', () => {
    expect(parse('echo hello', { timeoutMs: 0 })).toEqual({ ok: false, reason: 'aborted' });
  });
});
