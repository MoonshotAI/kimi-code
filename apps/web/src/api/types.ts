// apps/web src/api/types.ts — re-export the api types from web-core so the many
// existing `import … from '../api/types'` (and '../../api/types') sites keep
// working without per-file rewrites. The single source of truth now lives in
// @moonshot-ai/web-core/api.
export * from '@moonshot-ai/web-core/api';
