// packages/app-composer/src/mention-dom.ts
// The pill content types' DOM layer: type icons, the pill builders, the
// composer's pill selection painting, the document-level hover tooltip
// singleton, and the user-message renderer (ComposerText).
export * from './icons';
export * from './mentionIcons';
export * from './mentionMatch';
export * from './mentionPill';
export * from './attachmentPill';
export * from './attachmentTarget';
export * from './clipboardWrite';
export * from './mentionSelectionSync';
export * from './mentionTooltip';
export { default as ComposerText } from './ComposerText.vue';
