// src/node.ts
//
// Syntax tree node model. Named node types correspond one-to-one with
// tree-sitter-bash's named node types, so consumers can write tree queries
// against either implementation. Two deliberate deviations from tree-sitter:
//
//   - startIndex / endIndex are UTF-16 code unit offsets (native JS string
//     indexing), not tree-sitter's UTF-8 byte offsets. `node.text` therefore
//     always equals `source.slice(node.startIndex, node.endIndex)`.
//   - `text` is pre-computed when the node is created instead of being
//     re-sliced on every access.
//
// Child semantics: `children` contains every child in source order, including
// anonymous (punctuation / keyword token) nodes; `namedChildren` contains only
// the named ones, in the same relative order. Anonymous nodes never appear in
// `namedChildren`. `descendantsOfType` walks named descendants only, matching
// how tree-sitter queries see the tree.

export interface SyntaxNode {
  /** Node type, e.g. 'program', 'command', 'word'. Matches tree-sitter-bash. */
  readonly type: string;
  /** Source text covered by this node (UTF-16 slice of the original source). */
  readonly text: string;
  /** Start offset in UTF-16 code units, inclusive. */
  readonly startIndex: number;
  /** End offset in UTF-16 code units, exclusive. */
  readonly endIndex: number;
  /** Whether this is a named node (false for punctuation/keyword tokens). */
  readonly isNamed: boolean;
  readonly parent: SyntaxNode | null;
  /** All children in source order, named and anonymous. */
  readonly children: readonly SyntaxNode[];
  /** Named children only, in source order. */
  readonly namedChildren: readonly SyntaxNode[];
}

export interface NodeInit {
  type: string;
  source: string;
  startIndex: number;
  endIndex: number;
  isNamed?: boolean;
}

/**
 * Mutable node under construction. The parser builds trees with this class and
 * exposes them through the readonly `SyntaxNode` interface; once a node is
 * handed out it must be treated as immutable.
 */
export class SyntaxNodeBuilder {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  parent: SyntaxNodeBuilder | null = null;
  readonly children: SyntaxNodeBuilder[] = [];
  readonly namedChildren: SyntaxNodeBuilder[] = [];

  constructor(init: NodeInit) {
    if (init.startIndex < 0 || init.endIndex < init.startIndex || init.endIndex > init.source.length) {
      throw new RangeError(
        `invalid node range [${init.startIndex}, ${init.endIndex}) for source of length ${init.source.length}`,
      );
    }
    this.type = init.type;
    this.startIndex = init.startIndex;
    this.endIndex = init.endIndex;
    this.isNamed = init.isNamed ?? true;
    this.text = init.source.slice(init.startIndex, init.endIndex);
  }

  /** Attach a child, wiring its parent pointer. Named children are also added
   *  to `namedChildren`. Returns the child for chaining.
   *
   *  Children must lie inside the parent's range and be appended in source
   *  order without overlapping the previous sibling (a zero-width child may
   *  start exactly where the previous sibling ends). */
  addChild<T extends SyntaxNodeBuilder>(child: T): T {
    if (child.parent !== null) throw new Error(`node '${child.type}' already has a parent`);
    if (child.startIndex < this.startIndex || child.endIndex > this.endIndex) {
      throw new RangeError(
        `child '${child.type}' [${child.startIndex}, ${child.endIndex}) escapes parent '${this.type}' [${this.startIndex}, ${this.endIndex})`,
      );
    }
    const last = this.children.at(-1);
    if (last !== undefined && child.startIndex < last.endIndex) {
      throw new RangeError(
        `child '${child.type}' [${child.startIndex}, ${child.endIndex}) overlaps sibling '${last.type}' [${last.startIndex}, ${last.endIndex})`,
      );
    }
    child.parent = this;
    this.children.push(child);
    if (child.isNamed) this.namedChildren.push(child);
    return child;
  }
}

/** Convenience factory for a detached node. */
export function createNode(init: NodeInit): SyntaxNodeBuilder {
  return new SyntaxNodeBuilder(init);
}

/**
 * Pre-order traversal of the named descendants of `root` (not including
 * `root` itself), filtered to the given types. With no types, returns every
 * named descendant in pre-order. Iterative with an explicit stack so that
 * pathologically deep trees cannot overflow the call stack.
 */
export function descendantsOfType(root: SyntaxNode, ...types: string[]): SyntaxNode[] {
  const wanted = types.length > 0 ? new Set(types) : null;
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [];
  for (let i = root.namedChildren.length - 1; i >= 0; i--) stack.push(root.namedChildren[i]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (wanted === null || wanted.has(node.type)) out.push(node);
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]!);
  }
  return out;
}
