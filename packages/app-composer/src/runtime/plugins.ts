import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, selectTextblockEnd, selectTextblockStart } from 'prosemirror-commands';
import { analyzeLeadingSlashCommand, type SlashCommand } from '@moonshot-ai/app-core/lib';
import { composerSchema, docText, extendToTextblock, mayStartWithSlashCommand, normalizedDocText, textOffsetToPos, type AttachmentAttrs, type PastedTextAttrs, type QuoteAttrs } from '../model';
import { attachmentRegistryKey } from '../features/attachment/registry';
import { buildComposerClipboardCopy, COMPOSER_CLIPBOARD_MIME, stashComposerFlavor } from '../features/attachment/clipboard';
import type { AttachmentEntry } from '../features/attachment/entry';
import { createAttachmentInventoryPlugin } from '../features/attachment/inventory';
import { browserReferenceKey, createBrowserReferencePlugin, type BrowserReferenceInitialState } from '../features/browser-reference/inventory';

export function clipboardHasFiles(e: ClipboardEvent): boolean {
  const cd = e.clipboardData;
  if (!cd) return false;
  if (cd.files.length > 0) return true;
  return Array.from(cd.items).some((item) => item.kind === 'file');
}

const trailingPillCaretAnchor = new Plugin({
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      state.doc.forEach((para, paraStart) => {
        const last = para.lastChild;
        if (last && (last.type === composerSchema.nodes.mention || last.type === composerSchema.nodes.attachment || last.type === composerSchema.nodes.quote || last.type === composerSchema.nodes.pasted_text)) {
          const pos = paraStart + para.nodeSize - 1;
          decos.push(
            Decoration.widget(
              pos,
              () => {
                const span = document.createElement('span');
                span.className = 'mention-caret-anchor';
                span.textContent = '​';
                return span;
              },
              { side: 1, key: `mention-caret-anchor-${pos}` },
            ),
          );
        }
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

export const attachmentErrorDecorations = new Plugin({
  props: {
    decorations(state) {
      const entries = attachmentRegistryKey.getState(state);
      if (!entries) return null;
      const decos: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type !== composerSchema.nodes.attachment) return true;
        const entry = entries.get((node.attrs as AttachmentAttrs).attId);
        if (entry === undefined) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-missing' }));
          return false;
        }
        if (entry.error !== undefined) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-error' }));
        }
        return false;
      });
      return decos.length === 0 ? null : DecorationSet.create(state.doc, decos);
    },
  },
});

export function createLeadingSlashCommandDecorations(
  slashCommands?: () => ReadonlyArray<SlashCommand> | undefined,
): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (!mayStartWithSlashCommand(docText(state.doc))) return null;
        const match = analyzeLeadingSlashCommand(normalizedDocText(state.doc), slashCommands?.());
        if (!match) return null;
        return DecorationSet.create(state.doc, [
          Decoration.inline(
            textOffsetToPos(state.doc, match.commandRange.start),
            textOffsetToPos(state.doc, match.commandRange.end),
            { class: 'composer-command-token', 'data-command-name': match.item.name },
          ),
        ]);
      },
    },
  });
}

export const leadingSlashCommandDecorations = createLeadingSlashCommandDecorations();

export function createAttachmentErrorDecorations(
  lookupEntry: (attId: string) => AttachmentEntry | undefined,
): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type !== composerSchema.nodes.attachment) return true;
          const entry = lookupEntry((node.attrs as AttachmentAttrs).attId);
          if (entry === undefined) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-missing' }));
            return false;
          }
          if (entry.error !== undefined) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-error' }));
          }
          return false;
        });
        return decos.length === 0 ? null : DecorationSet.create(state.doc, decos);
      },
    },
  });
}

export const composerClipboardSerializer = new DOMSerializer(
  {
    ...DOMSerializer.nodesFromSchema(composerSchema),
    quote: (node: PMNode) => {
      const attrs = node.attrs as QuoteAttrs;
      const dataAttrs: Record<string, string> = { class: 'quote-pill', 'data-quote-text': attrs.text, style: 'white-space: pre-wrap' };
      if (typeof attrs.comment === 'string' && attrs.comment.length > 0) dataAttrs['data-quote-comment'] = attrs.comment;
      if (typeof attrs.source === 'string' && attrs.source.length > 0) dataAttrs['data-quote-source'] = attrs.source;
      const header = typeof attrs.source === 'string' && attrs.source.length > 0 ? `from: ${attrs.source}\n` : '';
      const comment = typeof attrs.comment === 'string' && attrs.comment.length > 0 ? `\n${attrs.comment}` : '';
      return ['span', dataAttrs, `${header}${attrs.text}${comment}`];
    },
    pasted_text: (node: PMNode) => ['span', { style: 'white-space: pre-wrap' }, (node.attrs as PastedTextAttrs).text],
  },
  DOMSerializer.marksFromSchema(composerSchema),
);

export function writeComposerClipboard(
  view: EditorView,
  event: ClipboardEvent,
  lookupEntry: (attId: string) => AttachmentEntry | undefined =
    (attId) => attachmentRegistryKey.getState(view.state)?.get(attId),
): boolean {
  const { selection } = view.state;
  if (selection.empty || !event.clipboardData) return false;
  const slice = selection.content();
  const copy = buildComposerClipboardCopy(
    slice,
    lookupEntry,
    browserReferenceKey.getState(view.state),
  );
  if (!copy) return false;
  const serializer = view.someProp('clipboardSerializer') ?? DOMSerializer.fromSchema(view.state.schema);
  const wrap = document.createElement('div');
  wrap.append(serializer.serializeFragment(slice.content));
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', copy.plain);
  event.clipboardData.setData('text/html', wrap.innerHTML);
  event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, stashComposerFlavor(copy.flavor));
  return true;
}

export function composerPlugins(
  initialEntries?: AttachmentEntry[],
  lookupEntry?: (attId: string) => AttachmentEntry | undefined,
  attachmentOrder?: readonly string[],
  browser?: BrowserReferenceInitialState,
  recognizeSlashCommands = true,
  slashCommands?: () => ReadonlyArray<SlashCommand> | undefined,
): Plugin[] {
  return [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Cmd-ArrowLeft': selectTextblockStart,
      'Cmd-ArrowRight': selectTextblockEnd,
      'Cmd-Shift-ArrowLeft': extendToTextblock(true),
      'Cmd-Shift-ArrowRight': extendToTextblock(false),
    }),
    keymap(baseKeymap),
    trailingPillCaretAnchor,
    ...(recognizeSlashCommands ? [createLeadingSlashCommandDecorations(slashCommands)] : []),
    lookupEntry === undefined ? attachmentErrorDecorations : createAttachmentErrorDecorations(lookupEntry),
    createAttachmentInventoryPlugin(attachmentOrder ?? initialEntries?.map((entry) => entry.attId)),
    createBrowserReferencePlugin(browser),
  ];
}
