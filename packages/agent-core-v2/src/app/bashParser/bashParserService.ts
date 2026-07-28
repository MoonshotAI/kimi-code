/**
 * `bashParser` domain (L1) — `IBashParserService` implementation.
 *
 * Thin adapter over the pure `@moonshot-ai/tree-sitter-bash` package: runs
 * its budgeted `parse` and snapshots the returned tree into the wire-safe
 * `BashSyntaxNode` DTO (source-ordered children including anonymous tokens,
 * `parent` links dropped). The snapshot is iterative (explicit stack) for
 * the same reason the parser's own `materialize` is: a long left-associative
 * chain (e.g. `$((1+1+...))` with thousands of operands) produces a tree
 * thousands of levels deep, and a recursive walk would overflow the call
 * stack and throw `RangeError`, breaking the never-throws contract. Owns no
 * state and injects no services. Bound at App scope.
 */

import { parse } from '@moonshot-ai/tree-sitter-bash';
import type { SyntaxNode } from '@moonshot-ai/tree-sitter-bash';

import { LifecycleScope, registerScopedService, ScopeActivation } from '#/_base/di/scope';

import type { BashParseOptions, BashParseResult, BashSyntaxNode } from './bashParser';
import { IBashParserService } from './bashParser';

interface MutableBashSyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  isNamed: boolean;
  children: BashSyntaxNode[];
}

function snapshot(root: SyntaxNode): BashSyntaxNode {
  // Two passes over a pre-order walk: allocate every DTO first, then link
  // children — no recursion, so depth is bounded only by heap, not the call
  // stack.
  const order: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  const dtos = new Map<SyntaxNode, MutableBashSyntaxNode>();
  for (const node of order) {
    dtos.set(node, {
      type: node.type,
      text: node.text,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      isNamed: node.isNamed,
      children: [],
    });
  }
  for (const node of order) {
    const dto = dtos.get(node)!;
    for (const child of node.children) dto.children.push(dtos.get(child)!);
  }
  return dtos.get(root)!;
}

export class BashParserService implements IBashParserService {
  declare readonly _serviceBrand: undefined;

  parse(source: string, options: BashParseOptions = {}): BashParseResult {
    const result = parse(source, options);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, hasError: result.hasError, root: snapshot(result.rootNode) };
  }
}

registerScopedService(
  LifecycleScope.App,
  IBashParserService,
  BashParserService,
  ScopeActivation.OnDemand,
  'bashParser',
);
