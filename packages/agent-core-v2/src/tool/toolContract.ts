/**
 * `tool` domain (L3) — foundational tool model contract.
 *
 * Owns the tool model shared by every tool domain: the static metadata
 * (`ToolSource` / `ToolDefinition` / `ToolInfo`), the `ExecutableTool`
 * contract every tool implements (`resolveExecution` → `ToolExecution` →
 * `execute(ctx)`), the `ExecutableToolContext` it runs against, the raw and
 * finalized results (`ExecutableToolResult` / `ToolResult`), the streaming
 * `ToolUpdate`, and the `BuiltinTool` alias. Also owns the `ToolAccesses`
 * resource-access declarations an execution emits so the host scheduler can
 * run non-conflicting calls concurrently (together with their conflict
 * semantics), and the `isMcpToolName` name predicate. The `stopTurn` /
 * `stopBatchAfterThis` fields are internal loop-control hints stripped
 * before persistence. Execution hook contexts live in `toolExecutor`. No
 * scoped service.
 */

import type { ContentPart, ToolCall } from '#/app/llmProtocol/message';
import type { Tool } from '#/app/llmProtocol/tool';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

export type ExecutableToolOutput = string | ContentPart[];

export type ToolDeliveryKind = 'steer';

export interface ToolDeliveryMessage {
  readonly role: 'user';
  readonly content: readonly ContentPart[];
  readonly toolCalls?: readonly ToolCall[];
  readonly origin?: unknown;
}

export interface ToolDelivery {
  readonly kind: ToolDeliveryKind;
  readonly message: ToolDeliveryMessage;
}

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly note?: string;
  readonly delivery?: ToolDelivery | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  readonly message?: string | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly note?: string;
  readonly delivery?: ToolDelivery | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  customKind?: string | undefined;
  customData?: unknown;
}

export interface ExecutableToolContext {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  readonly onForegroundTaskStart?: ((taskId: string) => void) | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly approvalRule: string;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
}

export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly source?: ToolSource;
  readonly info?: Record<string, unknown>;
}

export interface ToolInfo extends ToolDefinition {
  readonly source: ToolSource;
}

export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

export type ToolResult = ExecutableToolResult & {
  readonly description?: string;
  readonly display?: ToolInputDisplay;
  readonly approvalRule?: string;
  readonly stopBatchAfterThis?: boolean;
};

export type ToolFileAccessOperation = 'read' | 'write' | 'readwrite' | 'search';

export interface ToolFileAccess {
  readonly kind: 'file';
  readonly operation: ToolFileAccessOperation;
  readonly path: string;
  readonly recursive?: boolean;
}

export interface ToolResourceAccessAll {
  readonly kind: 'all';
}

export type ToolResourceAccess = ToolFileAccess | ToolResourceAccessAll;
export type ToolAccesses = readonly ToolResourceAccess[];

export const ToolAccesses = {
  none(): ToolAccesses {
    return [];
  },

  all(): ToolAccesses {
    return [{ kind: 'all' }];
  },

  file(
    operation: ToolFileAccessOperation,
    path: string,
    options: { readonly recursive?: boolean } = {},
  ): ToolAccesses {
    return [{ kind: 'file', operation, path, recursive: options.recursive }];
  },

  readFile(path: string): ToolAccesses {
    return ToolAccesses.file('read', path);
  },

  readTree(path: string): ToolAccesses {
    return ToolAccesses.file('read', path, { recursive: true });
  },

  writeFile(path: string): ToolAccesses {
    return ToolAccesses.file('write', path);
  },

  writeTree(path: string): ToolAccesses {
    return ToolAccesses.file('write', path, { recursive: true });
  },

  readWriteFile(path: string): ToolAccesses {
    return ToolAccesses.file('readwrite', path);
  },

  readWriteTree(path: string): ToolAccesses {
    return ToolAccesses.file('readwrite', path, { recursive: true });
  },

  searchTree(path: string): ToolAccesses {
    return ToolAccesses.file('search', path, { recursive: true });
  },

  conflict(left: ToolAccesses, right: ToolAccesses): boolean {
    return left.some((leftAccess) =>
      right.some((rightAccess) => resourceAccessesConflict(leftAccess, rightAccess)),
    );
  },
};

function resourceAccessesConflict(left: ToolResourceAccess, right: ToolResourceAccess): boolean {
  if (left.kind === 'all' || right.kind === 'all') return true;
  if (!fileOperationsConflict(left.operation, right.operation)) return false;
  return fileAccessesOverlap(left, right);
}

function fileOperationsConflict(
  left: ToolFileAccessOperation,
  right: ToolFileAccessOperation,
): boolean {
  return fileOperationWrites(left) || fileOperationWrites(right);
}

function fileOperationWrites(operation: ToolFileAccessOperation): boolean {
  switch (operation) {
    case 'read':
    case 'search':
      return false;
    case 'write':
    case 'readwrite':
      return true;
  }
}

function fileAccessesOverlap(left: ToolFileAccess, right: ToolFileAccess): boolean {
  const leftPath = normalizePath(left.path);
  const rightPath = normalizePath(right.path);
  if (leftPath === rightPath) return true;

  const leftPrefix = leftPath.endsWith('/') ? leftPath : `${leftPath}/`;
  const rightPrefix = rightPath.endsWith('/') ? rightPath : `${rightPath}/`;
  return (
    (left.recursive === true && rightPath.startsWith(leftPrefix)) ||
    (right.recursive === true && leftPath.startsWith(rightPrefix))
  );
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  const folded = normalized.toLowerCase();
  if (folded.length > 1 && folded.endsWith('/')) {
    return folded.slice(0, -1);
  }
  return folded;
}

const MCP_NAME_PREFIX = 'mcp__';

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}
