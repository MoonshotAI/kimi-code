/**
 * @deprecated FROZEN — TS 迁移冻结（2026-08-10）。
 * 允许：关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配。
 * 禁止：新增功能、引擎逻辑、行为修补。新能力一律写 Rust（kimi-sdk / kimi-agent / crates/*）。
 * 依据：根 AGENTS.md「TS 冻结清单」+ CODEX_MIGRATION_PLAN.md §5。目标：kimi-protocol。
 */
export * from './envelope';
export * from './error-codes';
export * from './pagination';
export * from './time';
export * from './request-id';
export * from './events';
export * from './display';
export * from './ws-control';
export * from './asyncapi';

export * from './session';
export * from './workspace';
export * from './message';
export * from './approval';
export * from './question';
export * from './tool';
export * from './skill';
export * from './task';
export * from './fs';
export * from './file';
export * from './modelCatalog';

export * from './rest/meta';
export * from './rest/auth';
export * from './rest/oauth';
export * from './rest/session';
export * from './rest/snapshot';
export * from './rest/workspace';
export * from './rest/fsBrowse';
export * from './rest/message';
export * from './rest/prompt';
export * from './rest/approval';
export * from './rest/question';
export * from './rest/tool';
export * from './rest/skill';
export * from './rest/task';
export * from './rest/fs';
export * from './rest/file';
export * from './rest/modelCatalog';
export * from './rest/config';
export * from './rest/terminal';
export * from './rest/connection';
export * from './rest/guiStore';
