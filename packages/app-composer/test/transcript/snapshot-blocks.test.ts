import { describe, expect, it } from 'vitest';
import { attachmentNode, browserReferenceNode, composerSchema, createComposerSnapshot, mentionNode, quoteNode } from '../../src/model';
import { snapshotRenderBlocks } from '../../src/transcript/snapshotBlocks';

describe('snapshot transcript rendering', () => {
  it('preserves literal Markdown as text while retaining actual rich nodes and comments', () => {
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      composerSchema.text('[literal](file.md) '),
      mentionNode({ kind: 'file', name: 'Actual file', path: 'file.md' }),
      quoteNode({ text: 'Quoted source', comment: 'My comment' }),
      browserReferenceNode({ refId: 'ref-a', label: 'Element 1' }),
    ]), composerSchema.node('paragraph'), composerSchema.node('paragraph', null, [composerSchema.text('Last line')])]);
    const blocks = snapshotRenderBlocks(createComposerSnapshot(doc, [], []));
    expect(blocks[0]).toMatchObject({ type: 'inline', segments: [{ type: 'text', value: '[literal](file.md) ' }, { type: 'mention', attrs: { kind: 'file', path: 'file.md' } }] });
    expect(blocks[1]).toMatchObject({ type: 'quote', text: 'Quoted source', comment: 'My comment' });
    expect(blocks[2]).toMatchObject({ type: 'inline', segments: [{ type: 'browser-reference', attrs: { refId: 'ref-a' } }] });
    expect(blocks.filter((block) => block.type === 'sep')).toHaveLength(2);
  });

  it('keeps an annotated attachment comment and marks it like a quote block', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [attachmentNode({ attId: 'shot', name: 'Screenshot.png', kind: 'image', comment: 'Fix this' })]),
      composerSchema.node('paragraph', null, [attachmentNode({ attId: 'plain', name: 'plain.png', kind: 'image' }), composerSchema.text(' text')]),
    ]);
    const blocks = snapshotRenderBlocks(createComposerSnapshot(doc, [], []));
    expect(blocks[0]).toMatchObject({ type: 'inline', annotation: true, segments: [{ type: 'attachment', attrs: { attId: 'shot', comment: 'Fix this' } }] });
    expect(blocks[2]).not.toHaveProperty('annotation');
  });
});
