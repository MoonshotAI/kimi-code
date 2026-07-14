/**
 * `#/core` — the TUI's consumption surface over `@moonshot-ai/agent-core-v2`.
 *
 * Everything the TUI/entry chain needs is exported from here: the harness
 * (App level), the session facade, the error model, the event merging
 * helpers, the resume-replay builders, and the core-owned types (which also
 * re-export the v2 names used in public signatures). Additional v2 type
 * re-exports are added as Task 6-8 compile feedback demands them, not
 * preemptively.
 */

export * from './auth';
export * from './catalog';
export * from './errors';
export * from './event-types';
export * from './events';
export * from './harness';
export * from './replay';
export * from './session';
export * from './types';
export {
  buildImageCompressionCaption,
  COMPACTION_SUMMARY_PREFIX,
  compressImageForModel,
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/agent-core-v2';
