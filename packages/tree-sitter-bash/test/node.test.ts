import { describe, expect, it } from 'vitest';

import { createNode, descendantsOfType } from '#/node';

const SOURCE = 'echo foo; echo bar';

/** program
 *      ├─ command "echo foo"
 *      │    ├─ command_name "echo"
 *      │    │    └─ word "echo"
 *      │    └─ word "foo"
 *      ├─ ";" (anonymous)
 *      └─ command "echo bar"
 *           └─ word "bar"
 */
function buildTree() {
  const program = createNode({ type: 'program', source: SOURCE, startIndex: 0, endIndex: SOURCE.length });
  const cmd1 = program.addChild(createNode({ type: 'command', source: SOURCE, startIndex: 0, endIndex: 8 }));
  const name1 = cmd1.addChild(createNode({ type: 'command_name', source: SOURCE, startIndex: 0, endIndex: 4 }));
  name1.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 4 }));
  cmd1.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 5, endIndex: 8 }));
  program.addChild(createNode({ type: ';', source: SOURCE, startIndex: 8, endIndex: 9, isNamed: false }));
  const cmd2 = program.addChild(createNode({ type: 'command', source: SOURCE, startIndex: 10, endIndex: 18 }));
  cmd2.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 15, endIndex: 18 }));
  return program;
}

describe('createNode', () => {
  it('pre-stores text as the UTF-16 slice of the source', () => {
    const node = createNode({ type: 'word', source: SOURCE, startIndex: 5, endIndex: 8 });
    expect(node.text).toBe('foo');
    expect(node.startIndex).toBe(5);
    expect(node.endIndex).toBe(8);
    expect(node.isNamed).toBe(true);
    expect(node.parent).toBeNull();
  });

  it('rejects out-of-range offsets', () => {
    expect(() => createNode({ type: 'word', source: SOURCE, startIndex: -1, endIndex: 2 })).toThrow(RangeError);
    expect(() => createNode({ type: 'word', source: SOURCE, startIndex: 3, endIndex: 2 })).toThrow(RangeError);
    expect(() => createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 100 })).toThrow(RangeError);
  });

  it('rejects attaching a child that already has a parent', () => {
    const a = createNode({ type: 'program', source: SOURCE, startIndex: 0, endIndex: SOURCE.length });
    const b = createNode({ type: 'program', source: SOURCE, startIndex: 0, endIndex: SOURCE.length });
    const child = createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 4 });
    a.addChild(child);
    expect(() => b.addChild(child)).toThrow(/already has a parent/);
  });

  it('rejects children outside the parent range', () => {
    const parent = createNode({ type: 'command', source: SOURCE, startIndex: 0, endIndex: 8 });
    expect(() =>
      parent.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 9 })),
    ).toThrow(RangeError);
  });

  it('rejects overlapping or out-of-order siblings', () => {
    const parent = createNode({ type: 'command', source: SOURCE, startIndex: 0, endIndex: 8 });
    parent.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 2, endIndex: 5 }));
    expect(() => parent.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 4, endIndex: 7 }))).toThrow(
      RangeError,
    );
    expect(() => parent.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 2 }))).toThrow(
      RangeError,
    );
    // Adjacent (start == previous end) is fine.
    parent.addChild(createNode({ type: 'word', source: SOURCE, startIndex: 5, endIndex: 8 }));
    expect(parent.children).toHaveLength(2);
  });
});

describe('children vs namedChildren', () => {
  it('keeps anonymous nodes out of namedChildren but in children', () => {
    const program = buildTree();
    expect(program.children.map((c) => c.type)).toEqual(['command', ';', 'command']);
    expect(program.namedChildren.map((c) => c.type)).toEqual(['command', 'command']);
    expect(program.children[1]?.isNamed).toBe(false);
  });

  it('wires parent pointers', () => {
    const program = buildTree();
    const [cmd1] = program.namedChildren;
    expect(cmd1?.parent).toBe(program);
    expect(cmd1?.namedChildren[0]?.parent).toBe(cmd1);
  });
});

describe('descendantsOfType', () => {
  it('returns matching named descendants in pre-order', () => {
    const program = buildTree();
    const words = descendantsOfType(program, 'word');
    expect(words.map((w) => w.text)).toEqual(['echo', 'foo', 'bar']);
  });

  it('matches multiple types and skips anonymous nodes', () => {
    const program = buildTree();
    const nodes = descendantsOfType(program, 'command', ';');
    expect(nodes.map((n) => n.type)).toEqual(['command', 'command']);
  });

  it('returns every named descendant when no type is given', () => {
    const program = buildTree();
    expect(descendantsOfType(program).map((n) => n.type)).toEqual([
      'command',
      'command_name',
      'word',
      'word',
      'command',
      'word',
    ]);
  });

  it('does not include the root itself', () => {
    const leaf = createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 4 });
    expect(descendantsOfType(leaf, 'word')).toEqual([]);
  });

  it('handles pathologically deep trees without overflowing the stack', () => {
    // 200k-deep chain; a recursive walk would overflow the call stack.
    const depth = 200_000;
    const nodes = [];
    for (let i = 0; i < depth; i++) {
      nodes.push(createNode({ type: 'word', source: SOURCE, startIndex: 0, endIndex: 1 }));
    }
    for (let i = depth - 2; i >= 0; i--) {
      nodes[i]!.addChild(nodes[i + 1]!);
    }
    expect(descendantsOfType(nodes[0]!, 'word')).toHaveLength(depth - 1);
  });
});
