export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly parent: SyntaxNode | null;
  readonly children: readonly SyntaxNode[];
  readonly namedChildren: readonly SyntaxNode[];
}

export interface NodeInit {
  type: string;
  source: string;
  startIndex: number;
  endIndex: number;
  isNamed?: boolean;
}

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

export function createNode(init: NodeInit): SyntaxNodeBuilder {
  return new SyntaxNodeBuilder(init);
}

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
