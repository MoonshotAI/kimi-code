/**
 * @deprecated FROZEN — TS 迁移冻结（2026-08-10）。
 * 允许：关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配。
 * 禁止：新增功能、引擎逻辑、行为修补。新能力一律写 Rust（kimi-sdk / kimi-agent / crates/*）。
 * 依据：根 AGENTS.md「TS 冻结清单」+ CODEX_MIGRATION_PLAN.md §5。目标：退役（一次性）。
 */
// Public API surface for the kimi-cli → kimi-code migration tool.

export * from './types.js';
export { detectMigration } from './detect.js';
export {
  shouldSuppressMigration,
  type MigrationSuppressionInput,
} from './marker.js';
export { runMigration, type RunMigrationInput } from './run-migration.js';
export {
  resolveMigrationScope,
  type MigrationPromptResult,
  type AnyChoice,
  type Prompt1Choice,
  type Prompt2Choice,
} from './prompt.js';
