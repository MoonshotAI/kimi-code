// apps/desktop/src/renderer/types.ts — re-export the shared renderer types from
// app-core so the many existing `import … from '../types'` (and './types') sites
// keep working without per-file rewrites. The single source of truth now lives
// in @moonshot-ai/app-core/client/types.
export * from '@moonshot-ai/app-core/client/types';
