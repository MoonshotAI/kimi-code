// packages/app-composer/src/editor.ts
// The ProseMirror editor surface: createComposerEditor (the ComposerEditorApi
// — text/mention/undo-stack operations with textarea-compatible semantics),
// the per-session state cache behind stashState/restoreState, the work-mode
// pill / placeholder decoration layer (workModePill), and the TextFieldLike
// abstraction both editor implementations (PM editor, plain textarea)
// satisfy.
export * from './textField';
export * from './composerEditor';
export * from './workModePill';
export * from './editorStateCache';
