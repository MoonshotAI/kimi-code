// @moonshot-ai/app-components — product components shared by apps/web and the
// apps/desktop renderer. Source-only package: consumers' bundler transpiles
// these (`exports` points at ./src/*). Support modules (pure helpers,
// composables, assets) live alongside the components and are exported here.

export { default as KimiMascot } from './KimiMascot.vue';
export { default as KimiDoodle } from './KimiDoodle.vue';

export * from './chatTurnRendering';
export * from './chat/tool-calls/toolArgs';
export * from './chat/tool-calls/askUserToolParse';
export * from './admin/pageItems';
export * from './admin/formatAdminTime';
export * from './admin/adminBatchToast';
export * from './admin/useAnchoredMenu';
export * from './lib/toolMeta';
export * from './lib/activitySummary';
export { useDialogFocus } from './composables/useDialogFocus';
