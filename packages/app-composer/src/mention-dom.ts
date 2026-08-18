// packages/app-composer/src/mention-dom.ts
// The mention content type's DOM layer: type icons, the pill builder, the
// composer's pill selection painting, the document-level hover tooltip
// singleton, and the user-message renderer (ComposerText).
export * from './icons';
export * from './mentionIcons';
export * from './mentionPill';
export * from './mentionSelectionSync';
export * from './mentionTooltip';
export { default as ComposerText } from './ComposerText.vue';
