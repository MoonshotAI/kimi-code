# apps/kimi-code Development Guide

This file only contains rules local to `apps/kimi-code`. For cross-repo rules, see the root `AGENTS.md`.

> **FROZEN — TS 迁移冻结（2026-08-10）**：本应用剩余 TS（CLI 消费面 + i18n/utils/constant）是过渡态宿主，目标迁入 Rust（kimi-cli / kimi-tui）。
> - 允许：关键 bug 修复（崩溃 / 数据丢失 / 安全 / 生产日志污染）；测试基线必要适配。
> - 禁止：新增功能、引擎逻辑、行为修补、UI 微调。新能力一律写 Rust。
> - 历史：TS TUI 已退役（2026-08-09，`cba21d159`，删除 `src/tui/` + `test/tui/` 共 312 文件），交互 UI 由 Rust `kimi-tui` 提供。`write-tui` 技能只适用于已退役的 TS TUI，**不要**再按它修改本目录。

## 当前结构（TS TUI 退役后）

入口链：`src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts`。`bin/kimi.mjs` 优先平台 Rust 二进制，回退本 TS 入口。

- `src/main.ts`：TS 入口（FROZEN banner）。解析 CLI 参数、update preflight，委托 UI runner。
- `src/cli/`：CLI 消费面——`run-shell.ts`（Rust 二进制纯转发器）、`native-session*.ts` / `rust-engine.ts` / `session-engine.ts`（Rust 引擎桥接）、`run-prompt.ts` / `prompt-*.ts`（harness 消费）、`sub/`（acp/doctor/export/login/provider/upgrade/vis/web）。
- `src/shared/`：TS TUI 退役时从 `src/tui/` 移出的共享符号（`tui-config.ts` / `tui-session.ts` / `goal-command.ts` / `slash-command-*` / `terminal-constants.ts` / `theme/`），仅供 CLI 过渡态消费。
- `src/i18n/`、`src/utils/`、`src/constant/`、`src/migration/`、`src/native/`、`src/feedback/`、`src/generated/`：其余过渡态宿主逻辑。

## 约束（仍有效）

- 本应用只能通过 `@moonshot-ai/kimi-code-sdk` 消费核心能力，禁止直接 import `@moonshot-ai/agent-core`（已退役）。
- 新逻辑不得写进本目录 TS——一律写 Rust（kimi-cli / kimi-tui / kimi-agent）。
- 修本目录 TS bug 前，先核对 Rust 侧（kimi-cli / kimi-agent）是否已有等价能力或修复。

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
