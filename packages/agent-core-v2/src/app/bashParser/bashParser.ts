/**
 * `bashParser` domain (L1) — bash source parsing capability.
 *
 * Defines the `IBashParserService` that parses a bash source string into a
 * syntax tree through the pure `@moonshot-ai/tree-sitter-bash` package, plus
 * the wire-safe DTO types it returns: `BashSyntaxNode` drops the cyclic
 * `parent` link so results can cross the RPC boundary, and offsets are
 * UTF-16 code units (`text` always equals `source.slice(start, end)`). The
 * parse runs under a deterministic budget — budget exhaustion yields
 * `{ ok: false, reason: 'aborted' }` and malformed input yields
 * `hasError: true`, never a throw; callers that cannot analyze a command
 * must degrade on either signal. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly children: readonly BashSyntaxNode[];
}

export interface BashParseOptions {
  readonly timeoutMs?: number;
  readonly maxNodes?: number;
}

export type BashParseResult =
  | { readonly ok: true; readonly hasError: boolean; readonly root: BashSyntaxNode }
  | { readonly ok: false; readonly reason: 'aborted' };

export interface IBashParserService {
  readonly _serviceBrand: undefined;

  parse(source: string, options?: BashParseOptions): BashParseResult;
}

export const IBashParserService: ServiceIdentifier<IBashParserService> =
  createDecorator<IBashParserService>('bashParserService');
