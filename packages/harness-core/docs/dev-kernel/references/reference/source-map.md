# 代码定位与适用范围

Reference：在使用原语前，确认目标 checkout 的实现、导出入口与本技能的事实基线一致。

## 事实基线

- 本文档基于 `refact-237-09-16-human-domain-features` 的 `human/kernel` 实现，核对日期为 2026-09-16。
- 在包含 `doing/` 和 `kimi-code-app/` 的工作区根目录定位：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v2/src/human/`。
- Feature slot 已收进产品节点；v3 对照路径为 `packages/agent-core-v3/src/app/{appUnit,sessionUnit,agentUnit}.ts` 与 `packages/agent-core-v3/src/feature/`。
- 技能存放在 code-app 仓，不代表 code-app 已内置该 runtime；编写时其 `kimi-code/` submodule 中未找到 `human/kernel/runtime.ts`。
- 若任务 workspace 已归档，在用户指定的核心 checkout 中按下表的包内路径和符号重新定位；不要把文档里的路径当作已发布的包入口。

## 源码地图

以下路径均相对于核心 checkout 的 `packages/agent-core-v2/src/human/`。

| 路径 | 核对什么 |
|---|---|
| `kernel/runtime.ts` | `UnitNode`、setup 上下文、mount/ready/cleanup |
| `kernel/hooks.ts` | v3 setup hooks：`provide` / `inject` / `useExpose` / `useChildren` 等 |
| `kernel/index.ts` | 通常使用的 kernel 汇总导出 |
| `kernel/primitives.ts` | Vue 响应式原语、`createToken`、`createCollection` |
| `app/appUnit.ts` | App 产品节点：`useFeatureSlot('app')` 与 `mountApp` |
| `app/sessionUnit.ts` | Session 产品节点：`useFeatureSlot('session')`，`create()` 先等 session slot 再打开 journal |
| `app/agentUnit.ts` | Agent 产品节点：`useFeatureSlot('agent')` 就绪后再 `actor.start()` |
| `feature/agent.ts` | v3 Feature 的 Store 门面：`useAgentStore().fold` / `dispatch` |
| `test/kernel/runtime.test.ts` | scope、props、DI、事件、贡献与子节点管理的现有断言 |
| `test/feature/feature.test.ts` | session/agent feature 的就绪与卸载场景 |

## 导入约束

1. 先确认目标包的 manifest、路径映射和 `kernel/index.ts`，再写实际 import。
2. 不把核心源码中的 `#/kernel/index` 别名直接复制到 code-app；code-app 没有这个别名。
3. 单原语和操作指南中的片段省略 imports；从目标 checkout 的实际 kernel 入口引入所用符号。
4. [完整教程](../tutorials/counter-tree.md) 给出从核心 checkout 的 `.tmp/` 文件执行的相对 import，不要求新增依赖。
5. 响应式 API、`Token` 和 `CollectionToken` 来自 `primitives.ts`，由 kernel 入口转导出，不是 runtime 自行实现的响应式系统。
6. `runtime.ts` 还导出 `mountChild`、`handleFor`、`runUnit` 和 `StackEntry` 类型，但 `kernel/index.ts` 不转导出它们（`asUnit` 除外）；常规业务代码使用 `node.mount()` 和 `UnitHandle`。v3 的 setup hooks 在 `kernel/hooks.ts`。

## 使用前检查

- 比对目标实现，而不是按文档强行补一个不存在的 API。
- 用符号定位最新代码；不要依赖本文档编写时的行号。
- 区分当前行为与建议用法；实现发生变化时同步更新受影响的原子文档和索引。
