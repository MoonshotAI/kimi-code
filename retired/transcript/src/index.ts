/**
 * @deprecated FROZEN — TS 迁移冻结（2026-08-10）。
 * 允许：关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配。
 * 禁止：新增功能、引擎逻辑、行为修补。新能力一律写 Rust（kimi-sdk / kimi-agent / crates/*）。
 * 依据：根 AGENTS.md「TS 冻结清单」+ CODEX_MIGRATION_PLAN.md §5。目标：收编/退役。
 */
export * from './model/ids';
export * from './model/turn';
export * from './model/frame';
export * from './model/interaction';
export * from './model/attachment';
export * from './model/todo';
export * from './model/item';
export * from './model/task';
export * from './model/meta';
export * from './model/prompt';
export * from './ops/operation';
export { EMPTY_AGENT_STATE, applyOperation, appendAtOffset } from './ops/apply';
export type { AgentState, ApplyResult } from './ops/apply';
export * from './store/agentTranscript';
export * from './store/transcriptStore';
export * from './granularity/grade';
export * from './granularity/filterOps';
export * from './view/registry';
export * from './pagination/paginate';
export * from './history/groupTurns';
export * from './history/foldFacts';
export * from './contract/schema';
export * from './contract/events';
