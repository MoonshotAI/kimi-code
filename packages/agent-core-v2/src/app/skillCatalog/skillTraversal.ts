/**
 * `skillCatalog` domain (L3) — shared skill-tree traversal policy.
 *
 * Defines the directory exclusions and bounded depth used by filesystem
 * discovery; the skill-root watcher applies the same exclusions to live
 * events, keeping their observable tree topology aligned. Pure policy; no
 * scoped state.
 */

export const SKILL_SCAN_MAX_DEPTH = 8;

export function isSkillTraversalDirectory(name: string): boolean {
  return name !== 'node_modules' && !name.startsWith('.');
}
