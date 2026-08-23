import { parse } from '@moonshot-ai/tree-sitter-bash';
import type { SyntaxNode } from '@moonshot-ai/tree-sitter-bash';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';

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
