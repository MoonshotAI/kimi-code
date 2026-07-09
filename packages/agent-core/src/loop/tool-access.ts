export type ToolFileAccessOperation = 'read' | 'write' | 'readwrite' | 'search';

export interface ToolFileAccess {
  readonly kind: 'file';
  readonly operation: ToolFileAccessOperation;
  readonly path: string;
  readonly recursive?: boolean;
}

export interface ToolResourceAccessAll {
  /**
   * Arbitrary side effects or resources that cannot be represented as a
   * file access. This is intentionally operation-less and globally
   * exclusive for concurrency.
   */
  readonly kind: 'all';
}

export type ToolResourceAccess = ToolFileAccess | ToolResourceAccessAll;
export type ToolAccesses = readonly ToolResourceAccess[];

// ── Native module loading (lazy, with TS fallback) ──────────────────────────

let nativeModule: {
  nativeToolAccessesConflict?: (
    left: ReadonlyArray<{
      readonly kind: string;
      readonly operation?: string;
      readonly path?: string;
      readonly recursive?: boolean;
    }>,
    right: ReadonlyArray<{
      readonly kind: string;
      readonly operation?: string;
      readonly path?: string;
      readonly recursive?: boolean;
    }>,
  ) => boolean;
} | null | undefined;

function getNative() {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

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
    const mod = getNative();
    if (mod?.nativeToolAccessesConflict !== undefined) {
      return mod.nativeToolAccessesConflict(left, right);
    }
    return tsConflict(left, right);
  },
};

function tsConflict(left: ToolAccesses, right: ToolAccesses): boolean {
  return left.some((leftAccess) =>
    right.some((rightAccess) => resourceAccessesConflict(leftAccess, rightAccess)),
  );
}

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
