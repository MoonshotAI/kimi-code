// packages/app-composer/src/wire.ts
// The composer wire codec (pure, no DOM/PM-view): the plain-text anchor
// format every boundary shares (daemon transcript, drafts, queues, the TUI,
// the model payload), its schema/serialization/parsing, offset mapping,
// message-side classification, and clipboard transforms. The contract is
// this package's docs/wire-format.md, pinned by its corpus + exhaustive
// matrix tests.
export * from './composerTextDoc';
export * from './mentionLinkPath';
export * from './skillActivationEdit';
