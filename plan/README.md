# `packages/agent-core` di-v3 重构 — 变更计划

> 下一阶段重构的执行计划。从 `refactor/di-domain-runtime-services`（M0–M7 已完成）演进到 di-v3 目标架构。

## 文件

- **[`PLAN.md`](./PLAN.md)** — 决策、目标架构、偏离分析、阶段划分、风险、验收标准。
- **[`ROADMAP.md`](./ROADMAP.md)** — 原子化、有序、可验证的执行步骤（P0–P9，约 60–70 步）。

## 一句话

M0–M7 是 di-v3 的「地基 + 试点」。本计划把 di-v3 的主体结构（scope 机制、目录重组、工具按域、20 个 domain、基础设施下沉）分 10 个阶段演进到位，复用 M0–M7 已验证的地基，不推倒重来。

## 目标架构参考

di-v3 目标设计以 `/Users/moonshot/Projects/kimi-code-dev-2/plan/` 的 30 篇设计文档为准。关键文档：

| 文档 | 重点 |
|---|---|
| `2026.06.22-agent-core-Refactor-Overview.md` | 20 个 domain + 厚实现同居 + 工具注册 bootstrap |
| `2026.06.21-Domain 和 Scope 的划分.md` | 域 × scope 思维框架 |
| `2026.06.22-Scope-Mechanism.md` | scope = 子 InstantiationService 机制（核心） |
| `2026.06.21-Kosong-Kaos-Loop-v2.md` | 三大核心域 + 边界规则 |
| `2026.06.22-Bootstrap-Lifecycle.md` | 5 阶段启动 + shutdown |
| `2026.06.22-Restorable-Lifecycle.md` | Restorable resume |
| `2026.06.22-Infrastructure-To-Base-Utils.md` | `_base/` + `_utils/` 下沉 |
| `2026.06.22-RPC-Event-Domain.md` | RPC + 事件总线 |
| `2026.06.22-<Domain>-Domain.md`（×20） | 各 domain 详细设计 |

## 阶段速览

| 阶段 | 主题 | 估时（单人） |
|---|---|---|
| P0 | 地基与护栏 | 2–3d |
| P1 | scope 机制 | 8–12d |
| P2 | 基础设施下沉 | 3–5d |
| P3 | domain 目录迁移 | 10–15d |
| P4 | domain 拆分（→ 20） | 10–15d |
| P5 | 工具按域注册 | 5–8d |
| P6 | service scope 标注 | 8–12d |
| P7 | Agent 收窄 | 3–5d |
| P8 | bootstrap 生命周期 | 3–5d |
| P9 | 收尾 + 文档 | 2–3d |
| **合计** | | **54–81d（11–16 周）** |

## 执行方式

按 [`plan-lifecycle`](../../.claude/skills/plan-lifecycle/SKILL.md) 流程执行：

1. **frame** — PLAN.md（已完成）。
2. **atomic-plan** — ROADMAP.md（已完成）。
3. **execute** — 按 ROADMAP 逐 phase 执行（worker + reviewer 闭环，每步一个提交 + 一次验证）。
4. **resync** — 每 phase 结束后对比计划更新现状。
5. **handoff** — 跨 session 交接。

## 起点

- 分支：`refactor/di-domain-runtime-services`（或从它新建 `refactor/di-v3`）。
- 当前状态：M0–M7 已完成（58 提交，48 phase review PASS）。
- 目标：di-v3（20 个 domain × scope 二维矩阵）。

## 验收（终态）

- `packages/agent-core/src/services/` 消失。
- 20 个 domain 目录就位，每个有契约 + 厚实现 + 工具（如有）+ `register<Domain>Tools`。
- scope 机制就位（LifecycleScope / registerScopedService / I*Context / ScopeBuilder / manager）。
- 所有 service 标注 scope 并通过 registerScopedService 注册。
- `_base/` + `_utils/` 就位，lint 强制依赖方向。
- Agent 收窄到 3–4 服务。
- `bootstrap.ts::registerAllBuiltinTools` 是唯一工具注册入口。
- 全套 test + typecheck + fence green。
