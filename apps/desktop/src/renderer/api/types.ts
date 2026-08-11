// apps/web src/api/types.ts — re-export the api types from app-core so the many
// existing `import … from '../api/types'` (and '../../api/types') sites keep
// working without per-file rewrites. The single source of truth now lives in
// @moonshot-ai/app-core/api.
export * from '@moonshot-ai/app-core/api';
