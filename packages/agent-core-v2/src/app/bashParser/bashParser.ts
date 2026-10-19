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
