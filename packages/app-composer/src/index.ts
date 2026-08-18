// packages/app-composer/src/index.ts
// The composer rich-text package: the plain-text ↔ rich-text projection for
// chat composers. Three layers, also importable individually:
//   ./wire        — the wire codec (pure): serialization, parsing, offsets,
//                   message-side classification (composerTextDoc + link path)
//   ./editor      — the ProseMirror editor surface + TextFieldLike
//   ./mention-dom — mention pills, ComposerText, selection sync, hover tooltip
// New rich-text content types (post-mention) join the wire codec plus one
// DOM module each — see this package's docs/wire-format.md §9.
export * from './wire';
export * from './editor';
export * from './mention-dom';
