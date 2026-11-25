import type { SlashCommand } from '@moonshot-ai/app-core/lib';
import type { AttachmentAttrs, MentionAttrs, QuoteAttrs, SkillMentionRef } from '../model';
import type { ComposerDocumentSnapshot } from '../model/snapshot';
import type { BrowserCapture, BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { AttachmentEntry } from '../features/attachment/entry';
import type { AttachmentInventoryState } from '../features/attachment/inventory';
import type { WorkModePillSpec } from './workModePill';
import type { TextFieldLike } from './textField';
import type { PastedTextMeta } from '../features/pasted-text/pill';

export interface ComposerEditorOptions {
  initialText: string;
  initialSnapshot?: ComposerDocumentSnapshot;
  onChange: (text: string) => void;
  onSnapshotChange?: (snapshot: ComposerDocumentSnapshot) => void;
  onBrowserReferenceOpen?: (refId: string, anchor: HTMLElement) => void;
  onBrowserReferencesChange?: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  onBlur?: (event: FocusEvent) => void;
  onWorkModeDismiss?: () => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  pastedTextMeta?: PastedTextMeta;
  sessionLinks?: {
    enabled?: () => boolean;
    title: (sessionId: string) => string | undefined;
    loadTitle?: (sessionId: string) => Promise<string | undefined>;
  };
  recognizeSlashCommands?: boolean;
  slashCommands?: ReadonlyArray<SlashCommand>;
  attachments?: {
    initialEntries?: AttachmentEntry[];
    onInventoryChange?: (inventory: AttachmentInventoryState) => void;
    getEntries?: () => AttachmentEntry[];
    upsertEntry?: (entry: AttachmentEntry) => void;
    patchEntry?: (
      attId: string,
      patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
    ) => void;
    referenceName?: (entry: AttachmentEntry) => string;
    subscribe?: (listener: () => void) => () => void;
  };
}

export interface ComposerEditorApi extends TextFieldLike {
  readonly dom: HTMLElement;
  getText(): string;
  getSnapshot(): ComposerDocumentSnapshot;
  setSnapshot(snapshot: ComposerDocumentSnapshot): void;
  insertBrowserReference(capture: BrowserCapture, reference: BrowserReference, range?: { start: number; end: number }): void;
  updateBrowserReference(refId: string, comment: string, includeScreenshot?: boolean): void;
  getBrowserReferenceData(): { references: BrowserReference[]; captures: BrowserCapture[] };
  saveSelectionBookmark(): string;
  restoreSelectionBookmark(id: string): boolean;
  discardSelectionBookmark(id: string): void;
  setText(text: string, opts?: { entries?: AttachmentEntry[] }): void;
  setWorkMode(spec: WorkModePillSpec | null): void;
  setPlaceholder(text: string, opts?: { allowWhitespace?: boolean }): void;
  setSlashCommands(commands: ReadonlyArray<SlashCommand>): void;
  insertNewlineAtCaret(): void;
  insertMention(attrs: MentionAttrs, range: { start: number; end: number }): void;
  insertTextAt(offset: number, text: string, opts?: { reviveMentions?: boolean }): void;
  replaceTextRange(range: { start: number; end: number }, text: string): void;
  getSkillMentions(): SkillMentionRef[];
  insertAttachment(attrs: AttachmentAttrs, target?: number | { start: number; end: number }): void;
  insertAttachments(
    items: readonly {
      attrs: AttachmentAttrs;
      pos?: number;
      range?: { start: number; end: number };
      reference: boolean;
    }[],
  ): void;
  insertAttachmentWithText(attrs: AttachmentAttrs, text: string, pos?: number, entry?: AttachmentEntry): void;
  activateAttachment(attId: string, index?: number): void;
  reorderAttachment(attId: string, to: number): void;
  deactivateAttachment(attId: string): void;
  removeAttachmentReferences(attId: string): void;
  insertQuote(attrs: QuoteAttrs, comment?: string): void;
  upsertAttachmentEntry(entry: AttachmentEntry): void;
  updateAttachmentEntry(attId: string, patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>): void;
  refreshAttachmentLabels(): void;
  getAttachmentEntries(): AttachmentEntry[];
  getAttachmentInventory(): AttachmentInventoryState;
  getOrderedAttachmentIds(): string[];
  textOffsetAtCoords(coords: { left: number; top: number }): number | null;
  setEditable(editable: boolean): void;
  stashState(sessionId: string): void;
  restoreState(sessionId: string): boolean;
  destroy(): void;
}
