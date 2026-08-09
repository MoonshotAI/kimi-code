/**
 * @deprecated FROZEN — TS 迁移冻结（2026-08-10）。
 * 允许：关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配。
 * 禁止：新增功能、引擎逻辑、行为修补。新能力一律写 Rust（kimi-sdk / kimi-agent / crates/*）。
 * 依据：根 AGENTS.md「TS 冻结清单」+ CODEX_MIGRATION_PLAN.md §5。目标：裁并评估。
 */
export type { StatResult } from './types';
export type { KaosProcess } from './process';
export type { Kaos } from './kaos';
export type {
  Environment,
  EnvironmentDeps,
  OsKind,
  ShellName,
} from './environment';
export { detectEnvironment, detectEnvironmentFromNode } from './environment';
export {
  KaosError,
  KaosValueError,
  KaosFileExistsError,
  KaosShellNotFoundError,
} from './errors';
export { LocalKaos } from './local';
export {
  chdir,
  exec,
  execWithEnv,
  getCurrentKaos,
  getcwd,
  gethome,
  glob,
  iterdir,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  runWithKaos,
  setCurrentKaos,
  stat,
  writeBytes,
  writeText,
} from './current';
