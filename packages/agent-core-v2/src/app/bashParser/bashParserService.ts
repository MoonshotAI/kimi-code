/**
 * `bashParser` domain (L1) — `IBashParserService` implementation.
 *
 * Thin adapter over the pure `@moonshot-ai/tree-sitter-bash` package: runs
 * its budgeted `parse` and snapshots the returned tree into the wire-safe
 * `BashSyntaxNode` DTO (source-ordered children including anonymous tokens,
 * `parent` links dropped). Owns no state and injects no services. Bound at
 * App scope.
 */

import { parse } from '@moonshot-ai/tree-sitter-bash';
import type { SyntaxNode } from '@moonshot-ai/tree-sitter-bash';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { BashParseOptions, BashParseResult, BashSyntaxNode } from './bashParser';
import { IBashParserService } from './bashParser';

function snapshot(node: SyntaxNode): BashSyntaxNode {
  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    isNamed: node.isNamed,
    children: node.children.map(snapshot),
  };
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
  InstantiationType.Delayed,
  'bashParser',
);
